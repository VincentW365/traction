import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, WheelPosition } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { StatusHistoryService } from '../audit/status-history.service';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { ToWorkOrderDto } from './dto/to-work-order.dto';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { AddRecommendationDto } from './dto/add-recommendation.dto';
import { AddInspectionPhotoDto } from './dto/add-photo.dto';
import { InspectionQueryDto } from './dto/inspection-query.dto';
import { SignoffInspectionDto } from './dto/signoff-inspection.dto';
import { DecideRecommendationDto } from './dto/decide-recommendation.dto';
import { CustomerSignoffDto } from './dto/customer-signoff.dto';

const ENTITY = 'VehicleInspection';
const ALL_WHEELS: WheelPosition[] = ['LEFT_FRONT', 'RIGHT_FRONT', 'LEFT_REAR', 'RIGHT_REAR'];

export interface InspectionActor {
  sub: string;
  siteId: string | null;
  role: string;
}

/**
 * CR-2026-107 — what staff see if an inspection form is somehow unavailable.
 *
 * The old message ("No active ... template is configured ... run pnpm db:seed")
 * was a database fact shown to whoever happened to be standing at the vehicle.
 * A technician cannot run a seed, and telling them to is noise; a manager can
 * act, and needs the exact remedy. So the fact is the same and the instruction
 * is not. No ids, versions or table names reach any of them.
 */
export function inspectionUnavailableMessage(
  kind: 'VEHICLE_INSPECTION' | 'PRE_INSPECTION',
  role: string,
): string {
  const form = kind === 'PRE_INSPECTION' ? 'Pre-Job Inspection' : 'Vehicle Inspection';
  // ADMIN is the internal role code for a Manager (see docs/05_User_Roles_Permissions.md).
  const canAct = role === 'ADMIN' || role === 'MANAGER';
  return canAct
    ? `${form} is not set up for this site yet. Open Setup → Deployment → Required forms to confirm, ` +
        'then run the required form bootstrap (pnpm forms:ensure) against this environment. ' +
        'No other work is affected and nothing already recorded is at risk.'
    : `${form} is not set up for this site yet, so it cannot be started. ` +
        'Please let a manager know — this needs an administrator to turn the form on. ' +
        'The Job Sheet and the rest of the visit are unaffected.';
}

const DETAIL_INCLUDE = {
  items: { orderBy: { orderIndex: 'asc' as const } },
  wheelMeasurements: true,
  recommendations: { orderBy: { createdAt: 'asc' as const } },
  signatures: true,
  // CR-2026-087 — pre-inspection photos.
  photos: { orderBy: { createdAt: 'asc' as const } },
  customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
  vehicle: { select: { id: true, plateNumber: true, make: true, model: true, modelYear: true } },
  // mileageIn feeds the pre-inspection's odometer prefill — captured at check-in,
  // so nobody retypes a number the desk already recorded.
  serviceVisit: { select: { id: true, status: true, mileageIn: true } },
} satisfies Prisma.VehicleInspectionInclude;

/**
 * CR-2026-034 — Visual Inspection Form (C-2: API core).
 *
 * State machine DRAFT → COMPLETED → (SIGNED_OFF → CLOSED in C-3); CANCELLED from
 * DRAFT/COMPLETED. Transitions use conditional updateMany (race-safe). Edits are
 * allowed ONLY in DRAFT. StatusHistory + AuditLog written after the status write,
 * entityType='VehicleInspection'. C-2 does not implement sign-off, customer
 * decisions, or approved→work-order (C-3/C-5).
 */
@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly statusHistory: StatusHistoryService,
    private readonly serviceOrders: ServiceOrdersService,
  ) {}

  private assertSameSite(siteId: string, actor: InspectionActor): void {
    if (actor.role !== 'ADMIN' && actor.siteId !== siteId) {
      throw new NotFoundException('Inspection not found');
    }
  }

  /**
   * CR-2026-093 — technicians see the inspections for THEIR work, not the whole
   * shop's. Managers and advisors keep full site visibility; a technician's view is
   * limited to visits carrying an assignment that resolves to their own account.
   *
   * Expressed as a where-fragment so the list query and the by-id check enforce the
   * same rule from one definition.
   */
  private technicianScope(actor: InspectionActor): Prisma.VehicleInspectionWhereInput | null {
    if (actor.role !== 'TECHNICIAN') return null;
    return {
      OR: [
        {
          serviceVisit: {
            serviceOrders: {
              some: { assignments: { some: { technician: { userAccountId: actor.sub } } } },
            },
          },
        },
        // Their own records regardless of assignment: a pre-inspection is often taken
        // at the car BEFORE the assignment exists, and a technician must not lose
        // sight of a record they just created.
        { performedByUserId: actor.sub },
        { createdByUserId: actor.sub },
      ],
    };
  }

  private async assertTechnicianCanSee(inspectionId: string, actor: InspectionActor): Promise<void> {
    const scope = this.technicianScope(actor);
    if (!scope) return;
    const visible = await this.prisma.vehicleInspection.findFirst({
      where: { id: inspectionId, ...scope },
      select: { id: true },
    });
    if (!visible) throw new NotFoundException('Inspection not found');
  }

  async create(dto: CreateInspectionDto, actor: InspectionActor) {
    const visit = await this.prisma.serviceVisit.findUnique({
      where: { id: dto.serviceVisitId },
      select: { id: true, siteId: true, vehicleId: true, customerId: true },
    });
    if (!visit) throw new BadRequestException(`Service visit ${dto.serviceVisitId} not found`);
    if (!visit.vehicleId) throw new BadRequestException('Service visit has no vehicle to inspect');
    if (actor.role !== 'ADMIN' && actor.siteId !== visit.siteId) {
      throw new ForbiddenException('Cannot create an inspection for another site');
    }

    // CR-2026-093 — the two kinds carry different templates. A pre-inspection is a
    // photo-first condition record and legitimately has NO checklist items; only a
    // full vehicle inspection insists on them.
    const kind = dto.kind ?? 'VEHICLE_INSPECTION';
    // CR-2026-106 — the vehicle inspection must have items ON the row we use, so an
    // itemless newer version can never shadow a good one (docs/121 §C2). The same
    // predicate is applied by the seed, deploy-check and /health.
    const template = await this.prisma.inspectionTemplate.findFirst({
      where: { isActive: true, kind, ...(kind === 'VEHICLE_INSPECTION' ? { items: { some: {} } } : {}) },
      orderBy: { version: 'desc' },
      include: { items: { orderBy: { orderIndex: 'asc' } } },
    });
    if (!template || (kind === 'VEHICLE_INSPECTION' && template.items.length === 0)) {
      // CR-2026-107 — this should now be unreachable on a healthy deployment
      // (RequiredFormsBootstrap repairs it at every API start, and deploy:check
      // fails the deployment before it serves traffic). If it is ever seen, the
      // message must tell the person in front of the vehicle what to DO — not
      // print a database fact. Technical remedies go only to those who can act
      // on them; a technician or advisor gets a plain instruction instead.
      throw new BadRequestException(inspectionUnavailableMessage(kind, actor.role));
    }

    const inspection = await this.prisma.$transaction(async (tx) => {
      const seq = await tx.$queryRaw<{ next_val: number }[]>`
        SELECT COALESCE(MAX(CAST(SUBSTRING(inspection_number FROM 5) AS INTEGER)), 0) + 1 AS next_val
        FROM vehicle_inspections
        WHERE inspection_number ~ '^INS-[0-9]+$'
      `;
      const inspectionNumber = `INS-${String(seq[0].next_val).padStart(6, '0')}`;
      const created = await tx.vehicleInspection.create({
        data: {
          inspectionNumber,
          siteId: visit.siteId,
          serviceVisitId: visit.id,
          vehicleId: visit.vehicleId!,
          customerId: visit.customerId,
          templateId: template.id,
          templateVersion: template.version,
          kind,
          status: 'DRAFT',
          performedByUserId: actor.sub,
          createdByUserId: actor.sub,
        },
      });
      // Snapshot the active template's lines into immutable per-inspection items.
      // A pre-inspection has none — its substance is photographs and condition notes.
      if (kind === 'PRE_INSPECTION') return created;
      await tx.inspectionItem.createMany({
        data: template.items.map((ti) => ({
          inspectionId: created.id,
          category: ti.category,
          label: ti.label,
          orderIndex: ti.orderIndex,
          // CR-2026-093 — NOT_INSPECTED, never OK. A blank checklist used to claim
          // every component had been checked and passed before anyone opened the
          // bonnet, and a technician who filled in half the form silently signed off
          // the other half.
          result: 'NOT_INSPECTED' as const,
        })),
      });
      // One measurement row per wheel.
      await tx.inspectionWheelMeasurement.createMany({
        data: ALL_WHEELS.map((position) => ({ inspectionId: created.id, position })),
      });
      return created;
    });

    await this.statusHistory.record({ entityType: ENTITY, entityId: inspection.id, fromStatus: null, toStatus: 'DRAFT', changedByUserId: actor.sub });
    await this.audit.log({
      actorUserId: actor.sub,
      action: AUDIT_ACTIONS.INSPECTION_CREATED,
      entityType: ENTITY,
      entityId: inspection.id,
      afterJson: { inspectionNumber: inspection.inspectionNumber, serviceVisitId: visit.id, templateVersion: template.version },
      reasonCode: 'INSPECTION_CREATE',
    });

    return this.findById(inspection.id, actor);
  }

  /**
   * CR-2026-034 (C-2) list; extended in CR-2026-081 with an active/history split,
   * per-customer archive, date range, free-text search and a severity filter.
   * Staff-only (INSPECTION_VIEW) and site-scoped — the `q` search over customer
   * name / plate never reaches the public display.
   */
  async list(query: InspectionQueryDto, actor: InspectionActor) {
    const take = query.take ?? 50;
    const skip = query.skip ?? 0;
    if (actor.role !== 'ADMIN' && !actor.siteId) {
      return { items: [], total: 0, take, skip };
    }
    const where: Prisma.VehicleInspectionWhereInput = {};
    where.siteId = actor.role === 'ADMIN' ? query.siteId : actor.siteId!;
    if (query.serviceVisitId) where.serviceVisitId = query.serviceVisitId;
    if (query.customerId) where.customerId = query.customerId;
    if (query.kind) where.kind = query.kind;
    // CR-2026-097 — compose the technician scope under AND, never Object.assign:
    // the scope is an OR-fragment, and the free-text search below also builds an
    // OR. Assigning both onto `where` let the second overwrite the first, so a
    // technician who typed anything in the search box silently escaped their
    // assignment scope. AND keeps both constraints in force together.
    const techScope = this.technicianScope(actor);
    if (techScope) where.AND = [techScope];

    // Explicit status wins; otherwise `active` narrows to the work-still-needed set
    // (DRAFT/COMPLETED/SIGNED_OFF), dropping CLOSED/CANCELLED off the worklist.
    // CR-2026-097 — a finished VISIT also leaves the active queue: once the vehicle
    // is gone, its inspections are history, not work, whatever status they were
    // left in. The records stay untouched and reachable via the Visit Record,
    // customer/vehicle history, and the History tab here.
    if (query.status) {
      where.status = query.status;
    } else if (query.active) {
      where.status = { in: ['DRAFT', 'COMPLETED', 'SIGNED_OFF'] };
      where.serviceVisit = { status: { notIn: ['CLOSED', 'ABANDONED', 'CANCELLED'] } };
    }

    // Date range on createdAt (always populated; the display date falls back the
    // same way). dateTo is inclusive of the whole day.
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(`${query.dateFrom}T00:00:00.000Z`);
      if (query.dateTo) where.createdAt.lte = new Date(`${query.dateTo}T23:59:59.999Z`);
    }

    if (query.severity) {
      where.recommendations = { some: { severity: query.severity } };
    }

    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { inspectionNumber: { contains: q, mode: 'insensitive' } },
        { customer: { firstName: { contains: q, mode: 'insensitive' } } },
        { customer: { lastName: { contains: q, mode: 'insensitive' } } },
        { vehicle: { plateNumber: { contains: q, mode: 'insensitive' } } },
        // CR-2026-097 — one search box, many identifiers: visit/ticket number too.
        { serviceVisit: { visitNumber: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.vehicleInspection.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true, inspectionNumber: true, status: true, kind: true,
          createdAt: true, completedAt: true, signedOffAt: true, closedAt: true, customerAckAt: true,
          customer: { select: { id: true, firstName: true, lastName: true } },
          vehicle: { select: { id: true, plateNumber: true, make: true, model: true } },
          serviceVisit: { select: { id: true } },
          recommendations: { select: { severity: true } },
          _count: { select: { photos: true, recommendations: true } },
        },
      }),
      this.prisma.vehicleInspection.count({ where }),
    ]);

    const items = rows.map((r) => {
      const { recommendations, ...rest } = r;
      return {
        ...rest,
        // The operational "inspection date": when it actually happened, with a
        // fallback chain for historical rows that predate completedAt/closedAt.
        inspectionDate: r.completedAt ?? r.signedOffAt ?? r.createdAt,
        findings: {
          immediate: recommendations.filter((x) => x.severity === 'IMMEDIATE').length,
          future: recommendations.filter((x) => x.severity === 'FUTURE').length,
          total: recommendations.length,
        },
      };
    });

    return { items, total, take, skip };
  }

  async findById(id: string, actor: InspectionActor) {
    const inspection = await this.prisma.vehicleInspection.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!inspection) throw new NotFoundException('Inspection not found');
    this.assertSameSite(inspection.siteId, actor);
    await this.assertTechnicianCanSee(id, actor);
    const timeline = await this.statusHistory.findByEntity(ENTITY, id);
    return { ...inspection, timeline };
  }

  async update(id: string, dto: UpdateInspectionDto, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (existing.status !== 'DRAFT') throw new BadRequestException('Only DRAFT inspections can be edited');

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.VehicleInspectionUpdateInput = {};
      if (dto.batteryTestResult !== undefined) data.batteryTestResult = dto.batteryTestResult;
      if (dto.batteryFactoryCca !== undefined) data.batteryFactoryCca = dto.batteryFactoryCca;
      if (dto.batteryActualCca !== undefined) data.batteryActualCca = dto.batteryActualCca;
      if (dto.alignmentCheckNeeded !== undefined) data.alignmentCheckNeeded = dto.alignmentCheckNeeded;
      if (dto.wheelBalanceNeeded !== undefined) data.wheelBalanceNeeded = dto.wheelBalanceNeeded;
      if (dto.brakeInspectionPerformed !== undefined) data.brakeInspectionPerformed = dto.brakeInspectionPerformed;
      if (dto.priorBodyDamageNotes !== undefined) data.priorBodyDamageNotes = dto.priorBodyDamageNotes;
      if (dto.comments !== undefined) data.comments = dto.comments;
      if (dto.generalCondition !== undefined) data.generalCondition = dto.generalCondition;
      if (dto.visibleDamage !== undefined) data.visibleDamage = dto.visibleDamage;
      if (dto.damageNotes !== undefined) data.damageNotes = dto.damageNotes;
      if (dto.itemsLeftInside !== undefined) data.itemsLeftInside = dto.itemsLeftInside;
      if (dto.warningLights !== undefined) data.warningLights = dto.warningLights;
      if (dto.fuelLevelNote !== undefined) data.fuelLevelNote = dto.fuelLevelNote;
      if (dto.odometerReading !== undefined) data.odometerReading = dto.odometerReading;
      if (dto.noPhotoReason !== undefined) data.noPhotoReason = dto.noPhotoReason;
      if (dto.noPhotoReasonNote !== undefined) data.noPhotoReasonNote = dto.noPhotoReasonNote;
      if (Object.keys(data).length > 0) await tx.vehicleInspection.update({ where: { id }, data });

      for (const it of dto.items ?? []) {
        // Scope to this inspection so a caller can't edit another inspection's line.
        await tx.inspectionItem.updateMany({
          where: { id: it.itemId, inspectionId: id },
          data: { result: it.result, ...(it.note !== undefined ? { note: it.note } : {}) },
        });
      }
      for (const w of dto.wheels ?? []) {
        await tx.inspectionWheelMeasurement.updateMany({
          where: { inspectionId: id, position: w.position },
          data: {
            ...(w.brakeLiningMm !== undefined ? { brakeLiningMm: w.brakeLiningMm } : {}),
            ...(w.tireTread32nds !== undefined ? { tireTread32nds: w.tireTread32nds } : {}),
            ...(w.wearPattern !== undefined ? { wearPattern: w.wearPattern } : {}),
            ...(w.tirePressureBeforePsi !== undefined ? { tirePressureBeforePsi: w.tirePressureBeforePsi } : {}),
            ...(w.tirePressureAfterPsi !== undefined ? { tirePressureAfterPsi: w.tirePressureAfterPsi } : {}),
            ...(w.rotorOrDrum !== undefined ? { rotorOrDrum: w.rotorOrDrum } : {}),
          },
        });
      }
    });

    return this.findById(id, actor);
  }

  /**
   * CR-2026-087 — attach a pre-inspection photo.
   *
   * Allowed while the inspection is DRAFT or COMPLETED, deliberately wider than the
   * DRAFT-only rule for results: the point of these is to record the vehicle's
   * condition on arrival, and a technician may well take them after filling the
   * checklist but before the senior tech signs off. Once SIGNED_OFF the record is
   * immutable, so photos stop there like everything else.
   */
  async addPhoto(id: string, dto: AddInspectionPhotoDto, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({
      where: { id },
      select: { id: true, siteId: true, status: true },
    });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (!['DRAFT', 'COMPLETED'].includes(existing.status)) {
      throw new BadRequestException(
        'Photos can only be added before the inspection is signed off',
      );
    }

    return this.prisma.inspectionPhoto.create({
      data: {
        inspectionId: id,
        imageData: dto.imageData,
        caption: dto.caption ?? null,
        takenByUserId: actor.sub,
      },
      // Never echo the image back — the caller already has it, and it is large.
      select: { id: true, caption: true, takenByUserId: true, createdAt: true },
    });
  }

  /** CR-2026-087 — remove a photo taken in error. Same lifecycle rule as adding. */
  async deletePhoto(id: string, photoId: string, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({
      where: { id },
      select: { id: true, siteId: true, status: true },
    });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (!['DRAFT', 'COMPLETED'].includes(existing.status)) {
      throw new BadRequestException(
        'Photos can only be changed before the inspection is signed off',
      );
    }

    const photo = await this.prisma.inspectionPhoto.findFirst({
      where: { id: photoId, inspectionId: id },
      select: { id: true },
    });
    if (!photo) throw new NotFoundException('Photo not found on this inspection');

    await this.prisma.inspectionPhoto.delete({ where: { id: photoId } });
    return { deleted: true, photoId };
  }

  async addRecommendation(id: string, dto: AddRecommendationDto, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (existing.status !== 'DRAFT') throw new BadRequestException('Recommendations can only be added while DRAFT');

    if (dto.inspectionItemId) {
      const item = await this.prisma.inspectionItem.findFirst({ where: { id: dto.inspectionItemId, inspectionId: id }, select: { id: true } });
      if (!item) throw new BadRequestException('inspectionItemId does not belong to this inspection');
    }

    return this.prisma.inspectionRecommendation.create({
      data: {
        inspectionId: id,
        inspectionItemId: dto.inspectionItemId ?? null,
        severity: dto.severity,
        description: dto.description,
        suggestedServiceTypeCode: dto.suggestedServiceTypeCode ?? null,
      },
    });
  }

  async complete(id: string, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);

    // CR-2026-081 — stamp completedAt so history/records show an accurate date.
    const { count } = await this.prisma.vehicleInspection.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'COMPLETED', completedAt: new Date() } });
    if (count === 0) throw new BadRequestException('Inspection is not DRAFT');

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: 'DRAFT', toStatus: 'COMPLETED', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.INSPECTION_COMPLETED, entityType: ENTITY, entityId: id, afterJson: { status: 'COMPLETED' }, reasonCode: 'INSPECTION_COMPLETE' });

    return this.findById(id, actor);
  }

  /**
   * CR-2026-093 — deliberately not carried out, as opposed to CANCELLED (created in
   * error). The distinction matters in history: a skipped inspection says the shop
   * considered one and decided against it, with a reason and a name attached.
   */
  async skip(id: string, reason: string, actor: InspectionActor) {
    if (!reason?.trim()) throw new BadRequestException('Skipping needs a reason.');
    const existing = await this.prisma.vehicleInspection.findUnique({
      where: { id },
      select: { id: true, siteId: true, status: true },
    });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (existing.status !== 'DRAFT') {
      throw new BadRequestException('Only a draft can be marked skipped.');
    }

    await this.prisma.vehicleInspection.update({
      where: { id },
      data: { status: 'SKIPPED', skippedAt: new Date(), skippedByUserId: actor.sub },
    });
    await this.statusHistory.record({
      entityType: ENTITY, entityId: id, fromStatus: 'DRAFT', toStatus: 'SKIPPED', changedByUserId: actor.sub,
    });
    await this.audit.log({
      actorUserId: actor.sub,
      action: 'INSPECTION_SKIPPED',
      entityType: ENTITY,
      entityId: id,
      reasonCode: 'INSPECTION_SKIPPED',
      notes: reason,
    });
    return this.findById(id, actor);
  }

  async cancel(id: string, actor: InspectionActor) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);

    const { count } = await this.prisma.vehicleInspection.updateMany({
      where: { id, status: { in: ['DRAFT', 'COMPLETED'] } },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) throw new BadRequestException('Only DRAFT or COMPLETED inspections can be cancelled');

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: existing.status, toStatus: 'CANCELLED', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.INSPECTION_CANCELLED, entityType: ENTITY, entityId: id, beforeJson: { status: existing.status }, afterJson: { status: 'CANCELLED' }, reasonCode: 'INSPECTION_CANCEL' });

    return this.findById(id, actor);
  }

  // ─── C-3: sign-off + customer decisions (results are immutable once SIGNED_OFF — the
  // DRAFT-only guards on update()/addRecommendation() enforce that) ────────────

  /** Senior-tech sign-off: COMPLETED → SIGNED_OFF + acknowledgment signature (drawn or typed). */
  async signoff(id: string, actor: InspectionActor, dto: SignoffInspectionDto) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);

    // `type` is optional → default TYPED (back-compat with `{ typedName }` callers).
    const type = dto.type ?? 'TYPED';
    const typedName = dto.typedName?.trim();
    if (type === 'DRAWN' && !dto.imageData) throw new BadRequestException('A drawn signature image is required to sign off');
    if (type === 'TYPED' && !typedName) throw new BadRequestException('A typed acknowledgment name is required to sign off');

    // Status flip + signature are atomic; the conditional updateMany is the race guard.
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicleInspection.updateMany({
        where: { id, status: 'COMPLETED' },
        data: { status: 'SIGNED_OFF', signedOffByUserId: actor.sub, signedOffAt: new Date() },
      });
      if (count === 0) throw new BadRequestException('Inspection must be COMPLETED to sign off');
      await tx.inspectionSignature.create({
        data: {
          inspectionId: id,
          role: 'SENIOR_TECH',
          type,
          typedName: type === 'TYPED' ? typedName : null,
          imageData: type === 'DRAWN' ? dto.imageData : null,
          signedByUserId: actor.sub,
        },
      });
    });

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: 'COMPLETED', toStatus: 'SIGNED_OFF', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.INSPECTION_SIGNED_OFF, entityType: ENTITY, entityId: id, afterJson: { status: 'SIGNED_OFF' }, reasonCode: 'INSPECTION_SIGNOFF' });
    return this.findById(id, actor);
  }

  /** Record the customer's decision on a recommendation (only while SIGNED_OFF). */
  async decideRecommendation(id: string, recommendationId: string, actor: InspectionActor, dto: DecideRecommendationDto) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true, status: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    if (existing.status !== 'SIGNED_OFF') throw new BadRequestException('Decisions can only be recorded after sign-off and before close');

    const rec = await this.prisma.inspectionRecommendation.findFirst({ where: { id: recommendationId, inspectionId: id }, select: { id: true } });
    if (!rec) throw new NotFoundException('Recommendation not found for this inspection');

    const updated = await this.prisma.inspectionRecommendation.update({
      where: { id: recommendationId },
      data: { customerDecision: dto.decision, decisionByUserId: actor.sub, decisionAt: new Date() },
    });
    await this.audit.log({
      actorUserId: actor.sub,
      action: AUDIT_ACTIONS.INSPECTION_RECOMMENDATION_DECISION,
      entityType: ENTITY,
      entityId: id,
      afterJson: { recommendationId, decision: dto.decision },
      reasonCode: 'INSPECTION_REC_DECISION',
    });
    return updated;
  }

  /** Customer sign-off: SIGNED_OFF → CLOSED + customer signature (drawn or typed). */
  async customerSignoff(id: string, actor: InspectionActor, dto: CustomerSignoffDto) {
    const existing = await this.prisma.vehicleInspection.findUnique({ where: { id }, select: { id: true, siteId: true } });
    if (!existing) throw new NotFoundException('Inspection not found');
    this.assertSameSite(existing.siteId, actor);
    const typedName = dto.typedName?.trim();
    if (dto.type === 'DRAWN' && !dto.imageData) throw new BadRequestException('A drawn signature image is required');
    if (dto.type === 'TYPED' && !typedName) throw new BadRequestException('A typed name is required');

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicleInspection.updateMany({
        where: { id, status: 'SIGNED_OFF' },
        // CR-2026-081 — stamp closedAt on the terminal transition.
        data: { status: 'CLOSED', customerAckByUserId: actor.sub, customerAckAt: new Date(), closedAt: new Date() },
      });
      if (count === 0) throw new BadRequestException('Inspection must be SIGNED_OFF before customer sign-off');
      await tx.inspectionSignature.create({
        data: {
          inspectionId: id,
          role: 'CUSTOMER',
          type: dto.type,
          typedName: dto.type === 'TYPED' ? typedName : null,
          imageData: dto.type === 'DRAWN' ? dto.imageData : null,
          signedByUserId: actor.sub,
        },
      });
    });

    await this.statusHistory.record({ entityType: ENTITY, entityId: id, fromStatus: 'SIGNED_OFF', toStatus: 'CLOSED', changedByUserId: actor.sub });
    await this.audit.log({ actorUserId: actor.sub, action: AUDIT_ACTIONS.INSPECTION_CUSTOMER_SIGNED, entityType: ENTITY, entityId: id, afterJson: { status: 'CLOSED', signatureType: dto.type }, reasonCode: 'INSPECTION_CUSTOMER_SIGNOFF' });
    return this.findById(id, actor);
  }

  // ─── C-5: turn an APPROVED recommendation into follow-up service work ─────────

  /**
   * Reuses the existing service-orders create path to make a DRAFT ServiceOrder
   * (one item, by service-type code) for the visit, and soft-links it back on the
   * recommendation. Does NOT modify the service-order flow; the original inspection
   * result is untouched (only the recommendation gains result* links).
   */
  async recommendationToWorkOrder(id: string, recommendationId: string, actor: InspectionActor, dto: ToWorkOrderDto) {
    const inspection = await this.prisma.vehicleInspection.findUnique({
      where: { id },
      select: { id: true, siteId: true, status: true, serviceVisitId: true, inspectionNumber: true },
    });
    if (!inspection) throw new NotFoundException('Inspection not found');
    this.assertSameSite(inspection.siteId, actor);
    if (!['SIGNED_OFF', 'CLOSED'].includes(inspection.status)) {
      throw new BadRequestException('Recommendations can be converted to work only after sign-off');
    }

    const rec = await this.prisma.inspectionRecommendation.findFirst({ where: { id: recommendationId, inspectionId: id } });
    if (!rec) throw new NotFoundException('Recommendation not found for this inspection');
    if (rec.customerDecision !== 'APPROVED') throw new BadRequestException('Only APPROVED recommendations can become work');
    if (rec.resultingServiceOrderItemId) throw new BadRequestException('This recommendation is already linked to work');

    const serviceTypeCode = (dto.serviceTypeCode ?? rec.suggestedServiceTypeCode ?? '').trim();
    if (!serviceTypeCode) throw new BadRequestException('A service type code is required to create work');

    // Reuse the normal service-order creation flow (new DRAFT order with this item).
    const order = await this.serviceOrders.create(
      { serviceVisitId: inspection.serviceVisitId, items: [{ serviceTypeCode, notes: `From inspection ${inspection.inspectionNumber}: ${rec.description}` }] },
      actor.sub,
    );
    const itemId = order.items?.[0]?.id ?? null;

    const updated = await this.prisma.inspectionRecommendation.update({
      where: { id: recommendationId },
      data: { resultingServiceOrderId: order.id, resultingServiceOrderItemId: itemId },
    });

    await this.audit.log({
      actorUserId: actor.sub,
      action: AUDIT_ACTIONS.INSPECTION_REC_TO_WORK_ORDER,
      entityType: ENTITY,
      entityId: id,
      afterJson: { recommendationId, serviceOrderId: order.id, serviceOrderItemId: itemId, serviceTypeCode },
      reasonCode: 'INSPECTION_REC_TO_WORK_ORDER',
    });
    return updated;
  }
}
