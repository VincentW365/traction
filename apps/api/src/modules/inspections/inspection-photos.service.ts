import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InspectionPhotoStorage, sha256 } from './storage/inspection-photo-storage';
import {
  inspectImage,
  stripMetadata,
  sanitizeFilename,
  ImageRejected,
  MAX_PHOTOS_PER_INSPECTION,
} from './storage/image-inspection';
import type { InspectionActor } from './inspections.service';

/**
 * CR-2026-093 — inspection photographs.
 *
 * Split from `InspectionsService` because photographs have their own lifecycle: bytes
 * pass through validation and a storage boundary, and evidence stops being editable at
 * a different point from the checklist.
 *
 * The rule that shapes the whole file: **while a record is DRAFT a photo is working
 * material; once completed it is evidence.** Drafts allow add, remove, recaption and
 * reorder. After completion nothing is deleted or overwritten — a correction adds a
 * replacement row that points at what it supersedes, with a reason and an actor, so
 * the trail shows what was replaced rather than what somebody would prefer it showed.
 */

const CAPTION_MAX = 500;

/** What a validated, stored photograph needs recording about it. */
export interface StoreResult {
  id: string;
  category: string;
  caption: string | null;
  sortOrder: number;
  isPrimary: boolean;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  mimeType: string | null;
  uploadedAt: Date | null;
}

@Injectable()
export class InspectionPhotosService {
  private readonly logger = new Logger(InspectionPhotosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: InspectionPhotoStorage,
  ) {}

  private assertSameSite(siteId: string, actor: InspectionActor): void {
    // Not-found rather than forbidden: whether a record exists at another site is
    // itself information, and a 403 confirms it.
    if (actor.role !== 'ADMIN' && actor.siteId !== siteId) {
      throw new NotFoundException('Inspection not found');
    }
  }

  private async loadInspection(id: string, actor: InspectionActor) {
    const inspection = await this.prisma.vehicleInspection.findUnique({
      where: { id },
      select: { id: true, siteId: true, status: true, kind: true, inspectionNumber: true },
    });
    if (!inspection) throw new NotFoundException('Inspection not found');
    this.assertSameSite(inspection.siteId, actor);
    return inspection;
  }

  /**
   * Validate, strip and store one image, then record its metadata.
   *
   * Shared by both entry points, so the multipart upload and the legacy base64 body
   * cannot drift apart on what they accept or where the bytes end up.
   */
  private async store(
    inspectionId: string,
    body: Buffer,
    originalFilename: string,
    actor: InspectionActor,
    meta: { caption?: string; category?: string } = {},
  ): Promise<StoreResult> {
    let facts;
    try {
      facts = inspectImage(body);
    } catch (e) {
      if (e instanceof ImageRejected) throw new BadRequestException(e.message);
      throw e;
    }

    const live = await this.prisma.inspectionPhoto.count({
      where: { inspectionId, deletedAt: null, supersededAt: null },
    });
    if (live >= MAX_PHOTOS_PER_INSPECTION) {
      throw new BadRequestException(
        `This record already has ${MAX_PHOTOS_PER_INSPECTION} photographs, which is the limit.`,
      );
    }

    // GPS coordinates, device serials and embedded preview frames do not belong in a
    // service record. Orientation was read out first so display can still compensate.
    const cleaned = stripMetadata(body, facts.mimeType);
    const stored = await this.storage.put(cleaned, facts.mimeType);

    const photo = await this.prisma.inspectionPhoto.create({
      data: {
        inspectionId,
        storageKey: stored.key,
        originalFilename: originalFilename.slice(0, 255),
        sanitizedFilename: sanitizeFilename(originalFilename, facts.mimeType),
        mimeType: facts.mimeType,
        byteSize: stored.byteSize,
        width: facts.width,
        height: facts.height,
        checksumSha256: stored.checksumSha256,
        category: (meta.category as never) ?? 'OTHER',
        caption: meta.caption?.slice(0, CAPTION_MAX) ?? null,
        sortOrder: live,
        // The first photograph on a record is its primary until someone says otherwise.
        isPrimary: live === 0,
        takenByUserId: actor.sub,
        uploadedByUserId: actor.sub,
        uploadedAt: new Date(),
      },
      select: {
        id: true, category: true, caption: true, sortOrder: true, isPrimary: true,
        width: true, height: true, byteSize: true, mimeType: true, uploadedAt: true,
      },
    });

    await this.audit.log({
      actorUserId: actor.sub,
      action: 'INSPECTION_PHOTO_UPLOADED',
      entityType: 'InspectionPhoto',
      entityId: photo.id,
      afterJson: {
        inspectionId,
        // Never the bytes, and never the checksum's subject — only what it is.
        mimeType: facts.mimeType,
        byteSize: stored.byteSize,
        width: facts.width,
        height: facts.height,
        category: photo.category,
      },
      notes: `Photograph added to inspection ${inspectionId}`,
    });

    return photo as StoreResult;
  }

  /** Multipart upload — the path a phone camera or a file picker uses. */
  async upload(
    id: string,
    file: { buffer: Buffer; originalname?: string; size?: number } | undefined,
    meta: { caption?: string; category?: string },
    actor: InspectionActor,
  ) {
    const inspection = await this.loadInspection(id, actor);
    this.assertPhotosMutable(inspection.status);
    if (!file?.buffer?.length) {
      throw new BadRequestException('No image was received.');
    }
    return this.store(id, file.buffer, file.originalname ?? 'photo', actor, meta);
  }

  /**
   * Legacy JSON body carrying a base64 data URL.
   *
   * Kept working because CR-2026-087's client posts this shape, but the bytes no
   * longer land in a database column: they are decoded here and go through exactly
   * the same validation and storage as an uploaded file.
   */
  async addFromDataUrl(
    id: string,
    dataUrl: string,
    caption: string | undefined,
    actor: InspectionActor,
  ) {
    const inspection = await this.loadInspection(id, actor);
    this.assertPhotosMutable(inspection.status);

    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new BadRequestException('That is not a valid image payload.');
    const body = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    return this.store(id, body, 'photo', actor, { caption });
  }

  /**
   * Photographs may be attached while DRAFT or COMPLETED.
   *
   * Wider than the DRAFT-only rule for checklist results, and deliberately: the point
   * of these is to record how the vehicle arrived, and a technician may photograph it
   * after filling the checklist but before a senior tech signs off. Sign-off is where
   * the record becomes immutable.
   */
  private assertPhotosMutable(status: string): void {
    if (!['DRAFT', 'COMPLETED'].includes(status)) {
      throw new BadRequestException(
        'This record is signed off — photographs can no longer be attached to it.',
      );
    }
  }

  async list(id: string, actor: InspectionActor) {
    await this.loadInspection(id, actor);
    return this.prisma.inspectionPhoto.findMany({
      where: { inspectionId: id, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, category: true, caption: true, sortOrder: true, isPrimary: true,
        width: true, height: true, byteSize: true, mimeType: true,
        uploadedAt: true, uploadedByUserId: true,
        supersedesPhotoId: true, supersededAt: true, correctionReason: true,
        // Never the bytes and never the storage key: the key is how the file is
        // reached internally, and handing it out would make the endpoint's
        // authorisation the only thing standing between a leak and the file.
      },
    });
  }

  /**
   * The bytes, for an authorised caller.
   *
   * Site and record authorisation are enforced here on every request rather than at
   * upload time only — a photograph is reachable for as long as it exists, so the
   * check has to happen when it is read.
   */
  async readBytes(
    id: string,
    photoId: string,
    actor: InspectionActor,
  ): Promise<{ body: Buffer; mimeType: string; filename: string }> {
    await this.loadInspection(id, actor);

    const photo = await this.prisma.inspectionPhoto.findFirst({
      where: { id: photoId, inspectionId: id, deletedAt: null },
      select: {
        storageKey: true, imageData: true, mimeType: true,
        sanitizedFilename: true, checksumSha256: true,
      },
    });
    if (!photo) throw new NotFoundException('Photo not found on this inspection');

    if (photo.storageKey) {
      const body = await this.storage.get(photo.storageKey);
      // A stored file whose bytes no longer match what was recorded is not served.
      // Better a visible failure than quietly presenting altered evidence as original.
      if (photo.checksumSha256 && sha256(body) !== photo.checksumSha256) {
        this.logger.error(
          `Checksum mismatch for photo ${photoId} — stored bytes differ from the recorded hash.`,
        );
        throw new NotFoundException('Photo not found on this inspection');
      }
      return {
        body,
        mimeType: photo.mimeType ?? 'application/octet-stream',
        filename: photo.sanitizedFilename ?? 'photo',
      };
    }

    // Pre-CR-2026-093 rows still carry their bytes inline. Read-only, never rewritten.
    if (photo.imageData) {
      const comma = photo.imageData.indexOf(',');
      const body = Buffer.from(photo.imageData.slice(comma + 1), 'base64');
      const declared = /^data:([^;]+);/.exec(photo.imageData)?.[1];
      return { body, mimeType: declared ?? 'image/jpeg', filename: 'photo' };
    }

    throw new NotFoundException('Photo not found on this inspection');
  }

  /** Caption, category, order and primary flag. Metadata only — never the bytes. */
  async updateMeta(
    id: string,
    photoId: string,
    patch: { caption?: string; category?: string; sortOrder?: number; isPrimary?: boolean },
    actor: InspectionActor,
  ) {
    const inspection = await this.loadInspection(id, actor);
    this.assertPhotosMutable(inspection.status);

    const photo = await this.prisma.inspectionPhoto.findFirst({
      where: { id: photoId, inspectionId: id, deletedAt: null },
      select: { id: true, caption: true, category: true, sortOrder: true, isPrimary: true },
    });
    if (!photo) throw new NotFoundException('Photo not found on this inspection');

    const updated = await this.prisma.$transaction(async (tx) => {
      // Exactly one primary per record, so the gallery and the print view agree on
      // which photograph leads.
      if (patch.isPrimary === true) {
        await tx.inspectionPhoto.updateMany({
          where: { inspectionId: id, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      return tx.inspectionPhoto.update({
        where: { id: photoId },
        data: {
          ...(patch.caption !== undefined ? { caption: patch.caption.slice(0, CAPTION_MAX) } : {}),
          ...(patch.category !== undefined ? { category: patch.category as never } : {}),
          ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
          ...(patch.isPrimary !== undefined ? { isPrimary: patch.isPrimary } : {}),
        },
        select: {
          id: true, category: true, caption: true, sortOrder: true, isPrimary: true,
        },
      });
    });

    await this.audit.log({
      actorUserId: actor.sub,
      action: 'INSPECTION_PHOTO_UPDATED',
      entityType: 'InspectionPhoto',
      entityId: photoId,
      beforeJson: photo,
      afterJson: updated,
      notes: `Photograph metadata changed on inspection ${id}`,
    });
    return updated;
  }

  /**
   * Remove a photograph.
   *
   * DRAFT only. After completion a photograph is evidence: it is not deleted, and the
   * refusal says so rather than pretending the record does not exist. Use a correction
   * instead, which preserves the original.
   */
  async remove(id: string, photoId: string, actor: InspectionActor) {
    const inspection = await this.loadInspection(id, actor);

    if (inspection.status !== 'DRAFT') {
      throw new BadRequestException(
        'This record is no longer a draft. Completed photographs are evidence and are ' +
          'not deleted — record a correction instead, which keeps the original.',
      );
    }

    const photo = await this.prisma.inspectionPhoto.findFirst({
      where: { id: photoId, inspectionId: id, deletedAt: null },
      select: { id: true, storageKey: true, isPrimary: true, category: true },
    });
    if (!photo) throw new NotFoundException('Photo not found on this inspection');

    await this.prisma.$transaction(async (tx) => {
      await tx.inspectionPhoto.update({
        where: { id: photoId },
        data: { deletedAt: new Date(), deletedByUserId: actor.sub, isPrimary: false },
      });
      if (photo.isPrimary) {
        const next = await tx.inspectionPhoto.findFirst({
          where: { inspectionId: id, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { id: true },
        });
        if (next) {
          await tx.inspectionPhoto.update({ where: { id: next.id }, data: { isPrimary: true } });
        }
      }
    });

    // The row is kept as a soft-deleted record so the audit trail still resolves, but
    // the file itself goes: a deleted draft photograph should not linger in storage.
    if (photo.storageKey) await this.storage.remove(photo.storageKey);

    await this.audit.log({
      actorUserId: actor.sub,
      action: 'INSPECTION_PHOTO_DELETED',
      entityType: 'InspectionPhoto',
      entityId: photoId,
      beforeJson: { inspectionId: id, category: photo.category },
      notes: `Draft photograph removed from inspection ${id}`,
    });
    return { deleted: true, photoId };
  }

  /**
   * Replace a completed photograph without destroying the original.
   *
   * The only way to change photographic evidence after completion, and it is additive:
   * the new row records what it supersedes, the old row is marked superseded, and both
   * remain. An authorised correction with a reason is traceable; an overwrite is not.
   */
  async correct(
    id: string,
    photoId: string,
    file: { buffer: Buffer; originalname?: string } | undefined,
    reason: string,
    actor: InspectionActor,
  ) {
    const inspection = await this.loadInspection(id, actor);
    if (!reason?.trim()) {
      throw new BadRequestException('A correction needs a reason.');
    }
    if (!file?.buffer?.length) {
      throw new BadRequestException('No replacement image was received.');
    }
    if (!['ADMIN', 'SERVICE_ADVISOR'].includes(actor.role)) {
      throw new ForbiddenException(
        'Correcting completed photographic evidence needs a manager or advisor.',
      );
    }

    const original = await this.prisma.inspectionPhoto.findFirst({
      where: { id: photoId, inspectionId: id, deletedAt: null, supersededAt: null },
      select: { id: true, category: true, caption: true, sortOrder: true, isPrimary: true },
    });
    if (!original) throw new NotFoundException('Photo not found on this inspection');

    const replacement = await this.store(id, file.buffer, file.originalname ?? 'photo', actor, {
      caption: original.caption ?? undefined,
      category: original.category,
    });

    await this.prisma.$transaction([
      this.prisma.inspectionPhoto.update({
        where: { id: photoId },
        data: { supersededAt: new Date(), correctedByUserId: actor.sub, correctionReason: reason },
      }),
      this.prisma.inspectionPhoto.update({
        where: { id: replacement.id },
        data: {
          supersedesPhotoId: photoId,
          sortOrder: original.sortOrder,
          isPrimary: original.isPrimary,
          correctionReason: reason,
          correctedByUserId: actor.sub,
        },
      }),
    ]);

    await this.audit.log({
      actorUserId: actor.sub,
      action: 'INSPECTION_PHOTO_CORRECTED',
      entityType: 'InspectionPhoto',
      entityId: replacement.id,
      beforeJson: { supersededPhotoId: photoId, inspectionNumber: inspection.inspectionNumber },
      afterJson: { replacementPhotoId: replacement.id },
      reasonCode: 'PHOTO_CORRECTION',
      notes: reason,
    });

    return { ...replacement, supersedesPhotoId: photoId };
  }
}
