import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * CR-2026-095 — resources and bays become fully application-managed.
 *
 * The rule this file exists to enforce: "we opened Bay 6" is an operational fact a
 * manager records in the application, not a deployment. Everything here writes
 * persisted configuration that the scheduler, dispatch board and assignment guards
 * read live.
 *
 * Three lifecycle layers, kept deliberately separate:
 *
 *   OPERATIONAL STATE   Available / Temporarily Unavailable / Maintenance / Out of
 *                       Service — today's mood, freely changed, always reversible.
 *   ACTIVE FLAG         Held out of use without a stated operational reason.
 *   RETIREMENT          Permanent. A retired resource takes no new work, keeps its
 *                       history, and never comes back through the status menu —
 *                       reactivation is its own explicit, audited act.
 *
 * Hard deletion exists ONLY for a resource that has never been referenced by any
 * operational record — a typo'd creation. Anything that ever held a vehicle is
 * history, and history is retired, not erased.
 */

export interface ResourceWriteModel {
  code?: string;
  name?: string;
  resourceCategory?: string;
  liftType?: string | null;
  maxVehicleWeight?: string | null;
  hasAlignment?: boolean;
  hasDiagnostics?: boolean;
  requiresMechanic?: boolean;
  showOnDispatchBoard?: boolean;
  supportsSedan?: boolean;
  supportsSuv?: boolean;
  schedulingEnabled?: boolean;
  capacity?: number;
  displayOrder?: number;
  isActive?: boolean;
  notes?: string | null;
}

const CATEGORIES = ['BAY', 'OVERFLOW', 'LIGHT_SLOT', 'POWER_WASH', 'EXTERNAL'];
const OP_STATES = ['AVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'MAINTENANCE', 'OUT_OF_SERVICE'];

@Injectable()
export class ResourceAdminService {
  private readonly logger = new Logger(ResourceAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Validation shared by create and update. Backend is authoritative (§30). */
  private validate(data: ResourceWriteModel, isCreate: boolean): void {
    if (isCreate) {
      if (!data.code?.trim()) throw new BadRequestException('A resource needs a code.');
      if (!data.name?.trim()) throw new BadRequestException('A resource needs a name.');
      if (!data.resourceCategory) throw new BadRequestException('Choose a resource type.');
    }
    if (data.code !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(data.code.trim())) {
      throw new BadRequestException(
        'Codes are 1–20 letters, digits, hyphens or underscores — they appear on the dispatch board and in audit logs.',
      );
    }
    if (data.name !== undefined && !data.name.trim()) {
      throw new BadRequestException('The name cannot be blank.');
    }
    if (data.resourceCategory !== undefined && !CATEGORIES.includes(data.resourceCategory)) {
      throw new BadRequestException(
        `"${data.resourceCategory}" is not a resource type this application supports. ` +
          'New behavioural types need application logic, not just a row.',
      );
    }
    if (data.capacity !== undefined && (!Number.isInteger(data.capacity) || data.capacity < 1)) {
      // Zero has no defined meaning here: "no concurrent work" is what
      // schedulingEnabled=false says, and two spellings of one fact will disagree.
      throw new BadRequestException('Capacity is a whole number of at least 1.');
    }
    if (data.supportsSedan === false && data.supportsSuv === false) {
      throw new BadRequestException(
        'A resource must support at least one vehicle class — a bay no vehicle can enter is not a bay.',
      );
    }
  }

  async create(siteId: string, data: ResourceWriteModel, actorUserId: string) {
    this.validate(data, true);

    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!site) throw new BadRequestException('Unknown site.');

    const code = data.code!.trim().toUpperCase();
    const duplicate = await this.prisma.workResource.findUnique({
      where: { siteId_code: { siteId, code } },
      select: { id: true, retiredAt: true },
    });
    if (duplicate) {
      throw new ConflictException(
        duplicate.retiredAt
          ? `Code ${code} belongs to a retired resource. Reactivate that one or choose a new code — reusing a retired code would fold two histories into one.`
          : `A resource with code ${code} already exists at this site.`,
      );
    }

    const resource = await this.prisma.workResource.create({
      data: {
        siteId,
        code,
        name: data.name!.trim(),
        resourceCategory: data.resourceCategory as never,
        liftType: data.liftType ?? null,
        maxVehicleWeight: (data.maxVehicleWeight as never) ?? null,
        hasAlignment: data.hasAlignment ?? false,
        hasDiagnostics: data.hasDiagnostics ?? false,
        requiresMechanic: data.requiresMechanic ?? true,
        showOnDispatchBoard: data.showOnDispatchBoard ?? true,
        supportsSedan: data.supportsSedan ?? true,
        supportsSuv: data.supportsSuv ?? true,
        schedulingEnabled: data.schedulingEnabled ?? true,
        capacity: data.capacity ?? 1,
        displayOrder: data.displayOrder ?? 0,
        isActive: data.isActive ?? true,
        notes: data.notes ?? null,
        // Born AVAILABLE, explicitly, so every consumer reads one source of truth.
        operationalStatus: { create: { status: 'AVAILABLE', isOperational: true, setByUserId: actorUserId } },
      },
      include: { operationalStatus: true },
    });

    await this.audit.log({
      actorUserId,
      action: 'RESOURCE_CREATE',
      entityType: 'WorkResource',
      entityId: resource.id,
      afterJson: { code: resource.code, name: resource.name, resourceCategory: resource.resourceCategory, supportsSedan: resource.supportsSedan, supportsSuv: resource.supportsSuv },
    });
    this.logger.log(`Resource ${resource.code} created by ${actorUserId}`);
    return resource;
  }

  /**
   * Edit operational configuration.
   *
   * `expectedUpdatedAt` is the concurrency guard (§31): the client sends the
   * updatedAt it loaded, and a mismatch means another manager saved in between —
   * refused with a message, never silently overwritten.
   */
  async update(
    id: string,
    data: ResourceWriteModel,
    actorUserId: string,
    expectedUpdatedAt?: string,
  ) {
    this.validate(data, false);

    const existing = await this.prisma.workResource.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Resource not found');
    if (existing.retiredAt && data.isActive !== undefined) {
      throw new BadRequestException(
        'This resource is retired. Reactivate it explicitly if it is genuinely returning to service.',
      );
    }

    if (expectedUpdatedAt && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
      throw new ConflictException(
        'This resource was changed by another user while you were editing. Refresh before saving your changes.',
      );
    }

    if (data.code !== undefined) {
      const code = data.code.trim().toUpperCase();
      if (code !== existing.code) {
        const clash = await this.prisma.workResource.findUnique({
          where: { siteId_code: { siteId: existing.siteId, code } },
          select: { id: true },
        });
        if (clash) throw new ConflictException(`A resource with code ${code} already exists at this site.`);
        data.code = code;
      }
    }

    const updated = await this.prisma.workResource.update({
      where: { id },
      data: {
        ...(data.code !== undefined ? { code: data.code } : {}),
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.resourceCategory !== undefined ? { resourceCategory: data.resourceCategory as never } : {}),
        ...(data.liftType !== undefined ? { liftType: data.liftType } : {}),
        ...(data.maxVehicleWeight !== undefined ? { maxVehicleWeight: data.maxVehicleWeight as never } : {}),
        ...(data.hasAlignment !== undefined ? { hasAlignment: data.hasAlignment } : {}),
        ...(data.hasDiagnostics !== undefined ? { hasDiagnostics: data.hasDiagnostics } : {}),
        ...(data.requiresMechanic !== undefined ? { requiresMechanic: data.requiresMechanic } : {}),
        ...(data.showOnDispatchBoard !== undefined ? { showOnDispatchBoard: data.showOnDispatchBoard } : {}),
        ...(data.supportsSedan !== undefined ? { supportsSedan: data.supportsSedan } : {}),
        ...(data.supportsSuv !== undefined ? { supportsSuv: data.supportsSuv } : {}),
        ...(data.schedulingEnabled !== undefined ? { schedulingEnabled: data.schedulingEnabled } : {}),
        ...(data.capacity !== undefined ? { capacity: data.capacity } : {}),
        ...(data.displayOrder !== undefined ? { displayOrder: data.displayOrder } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
    });

    // Before/after restricted to what changed, so the history reads as a diff.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(data) as (keyof ResourceWriteModel)[]) {
      if (data[key] === undefined) continue;
      before[key] = (existing as never)[key];
      after[key] = (updated as never)[key];
    }
    await this.audit.log({
      actorUserId,
      action: 'RESOURCE_UPDATE',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: before,
      afterJson: after,
    });
    return updated;
  }

  /** Graded status change — the "lift is being repaired" workflow (§11). */
  async setStatus(
    id: string,
    input: { status: string; reason?: string; expectedReturnAt?: string },
    actorUserId: string,
  ) {
    if (!OP_STATES.includes(input.status)) {
      throw new BadRequestException(`Unknown status. Use one of: ${OP_STATES.join(', ')}.`);
    }
    const resource = await this.prisma.workResource.findUnique({
      where: { id },
      include: { operationalStatus: true, occupancy: true },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    if (resource.retiredAt) {
      throw new BadRequestException('This resource is retired — reactivate it before changing its day-to-day status.');
    }
    if (input.status !== 'AVAILABLE' && !input.reason?.trim()) {
      throw new BadRequestException('Taking a resource out of service needs a reason — it appears on the board and in the history.');
    }

    const previous = resource.operationalStatus?.status ?? 'AVAILABLE';
    const result = await this.prisma.resourceOperationalStatus.upsert({
      where: { resourceId: id },
      update: {
        status: input.status as never,
        isOperational: input.status === 'AVAILABLE',
        reason: input.status === 'AVAILABLE' ? null : (input.reason ?? null),
        expectedReturnAt: input.expectedReturnAt ? new Date(input.expectedReturnAt) : null,
        statusSince: new Date(),
        setByUserId: actorUserId,
      },
      create: {
        resourceId: id,
        status: input.status as never,
        isOperational: input.status === 'AVAILABLE',
        reason: input.reason ?? null,
        expectedReturnAt: input.expectedReturnAt ? new Date(input.expectedReturnAt) : null,
        statusSince: new Date(),
        setByUserId: actorUserId,
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'RESOURCE_OPERATIONAL_STATUS_CHANGE',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: { status: previous },
      afterJson: { status: input.status, reason: input.reason ?? null, expectedReturnAt: input.expectedReturnAt ?? null },
      notes: input.reason,
    });
    this.logger.log(`Resource ${resource.code}: ${previous} -> ${input.status} by ${actorUserId}`);
    return result;
  }

  /** Permanent retirement (§9-§10). Refused while the resource holds live work. */
  async retire(id: string, reason: string, actorUserId: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('Retirement is permanent and needs a reason.');
    }
    const resource = await this.prisma.workResource.findUnique({
      where: { id },
      include: { occupancy: true },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    if (resource.retiredAt) throw new BadRequestException('Already retired.');
    if (resource.occupancy?.status === 'OCCUPIED') {
      throw new BadRequestException(
        `${resource.name} currently has a vehicle on it. Release the active work before retiring it.`,
      );
    }

    const futureReservations = await this.prisma.resourceReservation.count({
      where: { resourceId: id, status: { in: ['PENDING', 'ACTIVE'] }, reservedUntil: { gt: new Date() } },
    });
    if (futureReservations > 0) {
      throw new BadRequestException(
        `${resource.name} has ${futureReservations} upcoming reservation(s). Reassign or cancel them first — retiring now would strand those bookings.`,
      );
    }

    const updated = await this.prisma.workResource.update({
      where: { id },
      data: {
        retiredAt: new Date(),
        retiredByUserId: actorUserId,
        retireReason: reason,
        isActive: false,
        schedulingEnabled: false,
        showOnDispatchBoard: false,
      },
    });
    await this.audit.log({
      actorUserId,
      action: 'RESOURCE_RETIRE',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: { isActive: resource.isActive },
      afterJson: { retiredAt: updated.retiredAt },
      reasonCode: 'RESOURCE_RETIRE',
      notes: reason,
    });
    return updated;
  }

  /** The explicit road back. Returns AVAILABLE and visible, and says who did it. */
  async reactivate(id: string, actorUserId: string) {
    const resource = await this.prisma.workResource.findUnique({ where: { id } });
    if (!resource) throw new NotFoundException('Resource not found');
    if (!resource.retiredAt) throw new BadRequestException('This resource is not retired.');

    const updated = await this.prisma.workResource.update({
      where: { id },
      data: {
        retiredAt: null,
        retiredByUserId: null,
        retireReason: null,
        isActive: true,
        schedulingEnabled: true,
        showOnDispatchBoard: true,
        operationalStatus: {
          upsert: {
            update: { status: 'AVAILABLE', isOperational: true, reason: null, expectedReturnAt: null, statusSince: new Date(), setByUserId: actorUserId },
            create: { status: 'AVAILABLE', isOperational: true, setByUserId: actorUserId },
          },
        },
      },
    });
    await this.audit.log({
      actorUserId,
      action: 'RESOURCE_REACTIVATE',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: { retiredAt: resource.retiredAt, retireReason: resource.retireReason },
      afterJson: { retiredAt: null },
    });
    return updated;
  }

  /**
   * Hard delete — a typo'd creation only.
   *
   * The reference check is exhaustive on purpose: one historical assignment makes
   * this resource part of the shop's record, and the record does not get holes.
   */
  async deleteIfUnused(id: string, actorUserId: string) {
    const resource = await this.prisma.workResource.findUnique({ where: { id } });
    if (!resource) throw new NotFoundException('Resource not found');

    const [assignments, reservations, occupancy] = await Promise.all([
      this.prisma.technicianAssignment.count({ where: { resourceId: id } }),
      this.prisma.resourceReservation.count({ where: { resourceId: id } }),
      this.prisma.resourceOccupancy.findUnique({ where: { resourceId: id }, select: { serviceVisitId: true, status: true } }),
    ]);
    const everOccupied = occupancy?.serviceVisitId != null || occupancy?.status === 'OCCUPIED';

    if (assignments > 0 || reservations > 0 || everOccupied) {
      throw new BadRequestException(
        `${resource.name} has been used operationally (${assignments} assignment(s), ${reservations} reservation(s)` +
          `${everOccupied ? ', occupancy history' : ''}). It cannot be deleted — retire it instead, which keeps its history.`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.resourceOperationalStatus.deleteMany({ where: { resourceId: id } }),
      this.prisma.resourceOccupancy.deleteMany({ where: { resourceId: id } }),
      this.prisma.workResource.delete({ where: { id } }),
    ]);
    await this.audit.log({
      actorUserId,
      action: 'RESOURCE_DELETE',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: { code: resource.code, name: resource.name },
      notes: 'Hard delete of a never-used resource',
    });
    return { deleted: true, code: resource.code };
  }

  /** What a change would touch — powers the §29 warnings before the user commits. */
  async impact(id: string) {
    const resource = await this.prisma.workResource.findUnique({
      where: { id },
      include: { occupancy: true },
    });
    if (!resource) throw new NotFoundException('Resource not found');

    const now = new Date();
    const [futureReservations, activeAssignments, historicalAssignments] = await Promise.all([
      this.prisma.resourceReservation.count({
        where: { resourceId: id, status: { in: ['PENDING', 'ACTIVE'] }, reservedUntil: { gt: now } },
      }),
      this.prisma.technicianAssignment.count({
        where: { resourceId: id, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
      }),
      this.prisma.technicianAssignment.count({ where: { resourceId: id } }),
    ]);

    return {
      occupiedNow: resource.occupancy?.status === 'OCCUPIED',
      activeAssignments,
      futureReservations,
      historicalAssignments,
      everUsed: historicalAssignments > 0 || resource.occupancy?.serviceVisitId != null,
    };
  }

  /** Who did what to this resource — the §32 change history, from the audit log. */
  async history(id: string) {
    const events = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'WorkResource', entityId: id },
          { entityType: 'ResourceOperationalStatus', entityId: id },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, action: true, createdAt: true, beforeJson: true, afterJson: true,
        notes: true, reasonCode: true,
        actor: { select: { fullName: true } },
      },
    });
    return events.map((e) => ({
      id: e.id,
      at: e.createdAt,
      by: e.actor?.fullName ?? 'System',
      action: e.action,
      before: e.beforeJson,
      after: e.afterJson,
      reason: e.notes ?? e.reasonCode ?? null,
    }));
  }

  /** The §16 overview strip — operational counts, not analytics. */
  async overview(siteId: string) {
    const resources = await this.prisma.workResource.findMany({
      where: { siteId },
      include: { operationalStatus: true, occupancy: true },
    });
    const live = resources.filter((r) => !r.retiredAt);
    const state = (r: (typeof resources)[number]) => r.operationalStatus?.status ?? 'AVAILABLE';
    const isBay = (r: (typeof resources)[number]) => r.resourceCategory === 'BAY';

    return {
      totalActive: live.filter((r) => r.isActive).length,
      availableNow: live.filter(
        (r) => r.isActive && state(r) === 'AVAILABLE' && r.occupancy?.status !== 'OCCUPIED',
      ).length,
      inUse: live.filter((r) => r.occupancy?.status === 'OCCUPIED').length,
      maintenance: live.filter((r) => state(r) === 'MAINTENANCE').length,
      temporarilyUnavailable: live.filter((r) => state(r) === 'TEMPORARILY_UNAVAILABLE').length,
      outOfService: live.filter((r) => state(r) === 'OUT_OF_SERVICE').length,
      retired: resources.length - live.length,
      sedanBays: live.filter((r) => isBay(r) && r.isActive && r.supportsSedan).length,
      suvBays: live.filter((r) => isBay(r) && r.isActive && r.supportsSuv).length,
    };
  }
}
