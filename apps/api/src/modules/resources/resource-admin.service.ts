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
  /**
   * CR-2026-108 Stage 5B — what this contributes to simultaneous capacity.
   * Separate from `isActive` and from operational status on purpose: a primary
   * bay under maintenance is still a primary bay.
   */
  capacityRole?: string;
}

const CATEGORIES = ['BAY', 'OVERFLOW', 'LIGHT_SLOT', 'POWER_WASH', 'EXTERNAL'];
const OP_STATES = ['AVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'MAINTENANCE', 'OUT_OF_SERVICE'];
const CAPACITY_ROLES = [
  'UNVERIFIED',
  'PRIMARY_SERVICE_POSITION',
  'OVERFLOW_SERVICE_POSITION',
  'SUPPORT_EQUIPMENT',
  'PLACEHOLDER',
];
/** How a legacy bay with no current resource was accounted for. */
const BAY_DISPOSITIONS = ['UNRESOLVED', 'HISTORICAL_ONLY', 'REPLACED', 'RETIRED'];

/**
 * CR-2026-108 §15 — capabilities assignable before any service requires them.
 *
 * `capability` is a plain text column, so extending the vocabulary needs no enum
 * migration and carries no schema risk. CLEANING ships here because giving a wash
 * bay that capability must be possible BEFORE CLEAN-01 is remapped to require it —
 * and that remap changes the public catalogue, so it stays management's decision.
 * Until then, assigning CLEANING records a fact and changes no availability.
 *
 * Editable as a business rule, so a future capability needs no deployment either.
 */
export const RESOURCE_EXTRA_CAPABILITIES_KEY = 'resource_additional_capabilities';
export const RESOURCE_EXTRA_CAPABILITIES_DEFAULT = ['CLEANING'];

/**
 * Does someone still have to say what this is?
 *
 * Retired rows are out of the conversation, and an EXTERNAL row is excluded from
 * capacity by its category — classifying its physical position is not this shop's
 * call. Shared so the reconciliation view and the truth audit report the same
 * number; two spellings of "how much is left to do" would disagree on screen.
 */
const needsClassifying = (r: { capacityRole: string; retiredAt?: Date | null; resourceCategory?: unknown }): boolean =>
  r.capacityRole === 'UNVERIFIED' && !r.retiredAt && String(r.resourceCategory) !== 'EXTERNAL';

/**
 * Has the physical walk accounted for this legacy bay?
 *
 * Two ways, and they are equally valid: it is the same physical position as a
 * current resource (linked), or it is not there any more and somebody said so
 * (dispositioned). Requiring the first would push people into inventing links for
 * bays that were demolished in the expansion — and an invented link is a fact the
 * resource-aware engine would then reason from.
 *
 * Shared so the reconciliation view and the readiness gate cannot disagree.
 */
export const isBayResolved = (b: { resource?: unknown | null; reconciliationDisposition: string }): boolean =>
  b.resource != null || String(b.reconciliationDisposition) !== 'UNRESOLVED';

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
    if (data.capacityRole !== undefined && !CAPACITY_ROLES.includes(data.capacityRole)) {
      throw new BadRequestException(
        `"${data.capacityRole}" is not a capacity role. Choose one of: ${CAPACITY_ROLES.join(', ')}.`,
      );
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
        // §10 — a newly opened expansion bay needs no deployment and no legacy
        // link, but it also does not get to claim capacity on the strength of
        // having been typed in. It starts UNVERIFIED unless someone says otherwise.
        capacityRole: (data.capacityRole as never) ?? 'UNVERIFIED',
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
        ...(data.capacityRole !== undefined ? { capacityRole: data.capacityRole as never } : {}),
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

  /**
   * CR-2026-108 Stage 5B §8 — the vocabulary capabilities are allowed to use.
   *
   * Read from the data rather than hard-coded, so it cannot drift from what the
   * catalogue actually asks for. A capability nobody requires and no bay provides
   * would be a typo that silently excluded a resource from every pool.
   */
  async capabilityVocabulary(): Promise<string[]> {
    const [fromServices, fromBays, extra] = await Promise.all([
      this.prisma.serviceType.findMany({
        where: { requiredBayType: { not: null } },
        distinct: ['requiredBayType'],
        select: { requiredBayType: true },
      }),
      this.prisma.workBay.findMany({ distinct: ['bayType'], select: { bayType: true } }),
      this.prisma.businessRuleConfig.findFirst({
        where: { ruleKey: RESOURCE_EXTRA_CAPABILITIES_KEY, effectiveTo: null },
        select: { valueJson: true },
      }),
    ]);
    const all = new Set<string>();
    for (const s of fromServices) if (s.requiredBayType) all.add(s.requiredBayType);
    for (const b of fromBays) all.add(b.bayType);
    // CR-2026-108 §15 — capabilities the shop can assign BEFORE any service asks
    // for them. CLEANING is the case this exists for: a dedicated wash position
    // has to be configurable before CLEAN-01 can be remapped to require it, and
    // the remap is a separate public-catalogue decision. Assigning a capability
    // nothing requires changes no availability — it just records a fact.
    const configured = Array.isArray(extra?.valueJson) ? (extra.valueJson as unknown[]) : RESOURCE_EXTRA_CAPABILITIES_DEFAULT;
    for (const c of configured) if (typeof c === 'string' && c.trim()) all.add(c.trim().toUpperCase());
    return [...all].sort();
  }

  /**
   * §8/§9 — what kinds of work this physical position can take.
   *
   * Replace-set semantics: the caller sends the full list, because a bay that can
   * no longer do alignment must be able to stop, and an add-only API cannot say so.
   *
   * §9 is the part worth stating out loud: three capabilities on one resource means
   * one position that can do three kinds of work, NOT three positions. Nothing here
   * multiplies capacity — `capacity` is a separate field and is untouched.
   */
  async setCapabilities(id: string, capabilities: string[], actorUserId: string) {
    const resource = await this.prisma.workResource.findUnique({
      where: { id },
      select: { id: true, code: true, retiredAt: true, serviceCapabilities: { select: { capability: true } } },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    if (resource.retiredAt) {
      throw new BadRequestException('This resource is retired. Reactivate it before changing what work it can take.');
    }

    const wanted = [...new Set(capabilities.map((c) => c.trim().toUpperCase()).filter(Boolean))].sort();
    const vocabulary = await this.capabilityVocabulary();
    const unknown = wanted.filter((c) => !vocabulary.includes(c));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a kind of work' : 'are not kinds of work'} this platform recognises. ` +
          `Valid values are: ${vocabulary.join(', ')}. These come from the service catalogue — add the service first if a genuinely new kind of work exists.`,
      );
    }

    const before = resource.serviceCapabilities.map((c) => c.capability).sort();
    if (JSON.stringify(before) === JSON.stringify(wanted)) return { code: resource.code, capabilities: wanted, changed: false };

    await this.prisma.$transaction([
      this.prisma.workResourceCapability.deleteMany({ where: { resourceId: id, capability: { notIn: wanted } } }),
      this.prisma.workResourceCapability.createMany({
        data: wanted.map((capability) => ({ resourceId: id, capability })),
        skipDuplicates: true,
      }),
    ]);

    await this.audit.log({
      actorUserId,
      action: 'RESOURCE_CAPABILITIES_SET',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: { capabilities: before },
      afterJson: { capabilities: wanted },
    });
    this.logger.log(`Resource ${resource.code} capabilities set to [${wanted.join(', ')}] by ${actorUserId}`);
    return { code: resource.code, capabilities: wanted, changed: true };
  }

  /**
   * §5 — declare that this resource IS the legacy bay, or that it is not.
   *
   * Manual and explicit. The temptation is to match on code, and it would even
   * work for BAY-01; it would also quietly fuse two unrelated rows the first time
   * a code was reused, and nobody would ever see it happen.
   *
   * §7 — this writes one nullable pointer. No assignment, work order or history
   * row is touched, and unlinking restores exactly the state before linking.
   */
  async linkLegacyBay(id: string, legacyBayId: string | null, actorUserId: string) {
    const resource = await this.prisma.workResource.findUnique({
      where: { id },
      select: { id: true, code: true, siteId: true, legacyBayId: true },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    if (resource.legacyBayId === legacyBayId) return { code: resource.code, legacyBayId, changed: false };

    let bayCode: string | null = null;
    if (legacyBayId) {
      const bay = await this.prisma.workBay.findUnique({
        where: { id: legacyBayId },
        select: {
          id: true, code: true, siteId: true, reconciliationDisposition: true,
          resource: { select: { code: true } },
        },
      });
      if (!bay) throw new NotFoundException('That bay does not exist.');
      if (bay.siteId !== resource.siteId) {
        throw new BadRequestException('A resource can only be linked to a bay at the same site.');
      }
      if (bay.resource && bay.resource.code !== resource.code) {
        throw new ConflictException(
          `Bay ${bay.code} is already linked to resource ${bay.resource.code}. One bay is one physical position — unlink it there first.`,
        );
      }
      // The mirror of the check in setLegacyBayDisposition. Clearing it silently
      // here would erase somebody's recorded finding as a side effect of a link.
      if (bay.reconciliationDisposition !== 'UNRESOLVED') {
        throw new ConflictException(
          `${bay.code} was recorded as ${bay.reconciliationDisposition} — it is already resolved as history. ` +
            'Clear that disposition first if this resource really is the same physical position.',
        );
      }
      bayCode = bay.code;
    }

    await this.prisma.workResource.update({ where: { id }, data: { legacyBayId } });
    await this.audit.log({
      actorUserId,
      action: legacyBayId ? 'RESOURCE_LEGACY_BAY_LINK' : 'RESOURCE_LEGACY_BAY_UNLINK',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: { legacyBayId: resource.legacyBayId },
      afterJson: { legacyBayId, bayCode },
    });
    this.logger.log(
      legacyBayId
        ? `Resource ${resource.code} linked to legacy bay ${bayCode} by ${actorUserId}`
        : `Resource ${resource.code} unlinked from its legacy bay by ${actorUserId}`,
    );
    return { code: resource.code, legacyBayId, bayCode, changed: true };
  }

  /**
   * CR-2026-108 §1 — confirm that this record IS that physical bay.
   *
   * Management confirmed that eight heavy-lift bays exist. Nobody confirmed which
   * database rows they are: that mapping was inferred from names, lift types and a
   * code series, and an inference that looks identical to a verified fact is how a
   * provisional label quietly becomes a business truth.
   *
   * Confirming changes NO capacity. The shop has the bays either way; what changes
   * is what the readiness report is willing to claim about which row is which.
   */
  async setIdentityConfirmed(id: string, confirmed: boolean, actorUserId: string, note?: string) {
    const resource = await this.prisma.workResource.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, capacityRole: true, identityConfirmedAt: true, retiredAt: true },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    if (confirmed && resource.retiredAt) {
      throw new BadRequestException('This resource is retired — there is nothing standing in the building to confirm.');
    }
    const already = resource.identityConfirmedAt != null;
    if (already === confirmed) return { code: resource.code, confirmed, changed: false };

    await this.prisma.workResource.update({
      where: { id },
      data: {
        identityConfirmedAt: confirmed ? new Date() : null,
        identityConfirmedByUserId: confirmed ? actorUserId : null,
      },
    });
    await this.audit.log({
      actorUserId,
      action: confirmed ? 'RESOURCE_IDENTITY_CONFIRMED' : 'RESOURCE_IDENTITY_UNCONFIRMED',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: { identityConfirmed: already },
      afterJson: { identityConfirmed: confirmed, code: resource.code, name: resource.name },
      notes: note,
    });
    this.logger.log(`Resource ${resource.code} identity ${confirmed ? 'confirmed' : 'unconfirmed'} by ${actorUserId}`);
    return { code: resource.code, confirmed, changed: true };
  }

  /**
   * CR-2026-108 — resolve a legacy bay that has no current resource.
   *
   * The reconciliation gate used to demand a link for every legacy bay. On a floor
   * that has been physically reorganised that is sometimes impossible: a bay may
   * have been demolished, absorbed, or replaced by an arrangement matching no
   * single resource. The gate was therefore pushing towards inventing a link —
   * and an invented link is a fact the resource-aware engine would go on to reason
   * from. Saying "this one is history" is the honest answer, so it is now an answer
   * the system accepts.
   *
   * Nothing about the bay's history changes. Its assignments keep pointing at it,
   * and `status` — what the scheduler reads — is not touched.
   */
  async setLegacyBayDisposition(
    bayId: string,
    input: { disposition: string; note?: string },
    actorUserId: string,
  ) {
    const disposition = (input?.disposition ?? '').trim().toUpperCase();
    if (!BAY_DISPOSITIONS.includes(disposition)) {
      throw new BadRequestException(
        `"${input?.disposition}" is not a disposition. Choose one of: ${BAY_DISPOSITIONS.join(', ')}.`,
      );
    }
    const bay = await this.prisma.workBay.findUnique({
      where: { id: bayId },
      select: {
        id: true, code: true, reconciliationDisposition: true, dispositionNote: true,
        resource: { select: { code: true } },
        _count: { select: { assignments: true } },
      },
    });
    if (!bay) throw new NotFoundException('That bay does not exist.');

    // A linked bay is already resolved. Carrying both would be two answers to one
    // question, and the next reader would have to guess which one won.
    if (bay.resource && disposition !== 'UNRESOLVED') {
      throw new ConflictException(
        `${bay.code} is already matched to resource ${bay.resource.code}, which resolves it. ` +
          'Unlink it first if it should be recorded as history instead.',
      );
    }
    // A note is what makes this auditable a year from now. "REPLACED" on its own
    // tells a future reader nothing about what replaced it.
    const note = input.note?.trim() || null;
    if (disposition !== 'UNRESOLVED' && !note) {
      throw new BadRequestException(
        'Say briefly what happened to this bay — a disposition without a reason is not a record of anything.',
      );
    }

    if (bay.reconciliationDisposition === disposition && bay.dispositionNote === note) {
      return { code: bay.code, disposition, changed: false };
    }

    await this.prisma.workBay.update({
      where: { id: bayId },
      data: {
        reconciliationDisposition: disposition as never,
        dispositionNote: note,
        dispositionedAt: disposition === 'UNRESOLVED' ? null : new Date(),
        dispositionedByUserId: disposition === 'UNRESOLVED' ? null : actorUserId,
      },
    });
    await this.audit.log({
      actorUserId,
      action: 'LEGACY_BAY_DISPOSITION',
      entityType: 'WorkBay',
      entityId: bayId,
      beforeJson: { disposition: bay.reconciliationDisposition, note: bay.dispositionNote },
      afterJson: { disposition, note, historicalAssignments: bay._count.assignments },
      notes: note ?? undefined,
    });
    this.logger.log(`Legacy bay ${bay.code} dispositioned ${disposition} by ${actorUserId}`);
    return { code: bay.code, disposition, changed: true };
  }

  /**
   * §6 — the reconciliation view: both models side by side, nothing merged.
   *
   * Two inventories exist and disagree. This screen is how a person resolves that,
   * so it must show what each side actually contains, which rows are already paired,
   * and — the important column — which are not. A bay with 40 assignments and no
   * resource is not noise; it is the model scheduling has really been using.
   */
  async reconciliation(siteId: string) {
    const [resources, bays] = await Promise.all([
      this.prisma.workResource.findMany({
        where: { siteId },
        orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
        select: {
          id: true, code: true, name: true, resourceCategory: true, capacity: true,
          capacityRole: true, isActive: true, retiredAt: true, schedulingEnabled: true,
          identityConfirmedAt: true,
          legacyBayId: true,
          legacyBay: { select: { id: true, code: true, bayType: true } },
          operationalStatus: { select: { status: true } },
          serviceCapabilities: { select: { capability: true }, orderBy: { capability: 'asc' } },
        },
      }),
      this.prisma.workBay.findMany({
        where: { siteId },
        orderBy: { code: 'asc' },
        select: {
          id: true, code: true, bayType: true, status: true,
          reconciliationDisposition: true, dispositionNote: true, dispositionedAt: true,
          resource: { select: { id: true, code: true } },
          _count: { select: { assignments: true } },
        },
      }),
    ]);

    return {
      capabilityVocabulary: await this.capabilityVocabulary(),
      capacityRoles: CAPACITY_ROLES,
      resources: resources.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        category: String(r.resourceCategory),
        capacity: r.capacity,
        capacityRole: r.capacityRole,
        // §1 — mapped from a name and a code series, or confirmed by somebody
        // standing in front of it? Two different facts.
        identityConfirmed: r.identityConfirmedAt != null,
        capabilities: r.serviceCapabilities.map((c) => c.capability),
        // Absence of a status row means AVAILABLE — `setStatus` upserts on change.
        operationalStatus: r.operationalStatus?.status ?? 'AVAILABLE',
        isActive: r.isActive && !r.retiredAt,
        retired: r.retiredAt != null,
        schedulingEnabled: r.schedulingEnabled,
        link: r.legacyBay
          ? { state: 'LINKED' as const, bayId: r.legacyBay.id, bayCode: r.legacyBay.code, bayType: r.legacyBay.bayType }
          : { state: 'UNLINKED' as const, bayId: null, bayCode: null, bayType: null },
        // An EXTERNAL row is excluded from capacity by category, so leaving it
        // unclassified is not a gap in THIS shop's configuration. Counting it
        // here would put a number on screen that never reaches zero, and would
        // disagree with the audit's own incompleteness figure.
        needsAttention: needsClassifying(r),
      })),
      dispositions: BAY_DISPOSITIONS,
      legacyBays: bays.map((b) => ({
        id: b.id,
        code: b.code,
        bayType: b.bayType,
        status: b.status,
        historicalAssignments: b._count.assignments,
        link: b.resource
          ? { state: 'LINKED' as const, resourceId: b.resource.id, resourceCode: b.resource.code }
          : { state: 'UNLINKED' as const, resourceId: null, resourceCode: null },
        disposition: String(b.reconciliationDisposition),
        dispositionNote: b.dispositionNote,
        dispositionedAt: b.dispositionedAt?.toISOString() ?? null,
        // Linked OR explicitly accounted for. A bay that was demolished is
        // resolved by saying so, not by being pointed at the nearest new one.
        resolved: isBayResolved(b),
        // An unresolved bay that scheduling has actually used is the urgent case.
        needsAttention: !isBayResolved(b) && b._count.assignments > 0,
      })),
      summary: {
        resourceRows: resources.length,
        legacyBayRows: bays.length,
        linkedPairs: resources.filter((r) => r.legacyBayId).length,
        unlinkedResources: resources.filter((r) => !r.legacyBayId && !r.retiredAt).length,
        dispositionedBays: bays.filter((b) => String(b.reconciliationDisposition) !== 'UNRESOLVED').length,
        unresolvedBays: bays.filter((b) => !isBayResolved(b)).length,
        unresolvedBaysWithHistory: bays.filter((b) => !isBayResolved(b) && b._count.assignments > 0).length,
        unverifiedResources: resources.filter(needsClassifying).length,
      },
    };
  }

  /**
   * What a change would touch — powers the §29 warnings before the user commits.
   *
   * CR-2026-108 Stage 5B §14. The counts below are all keyed on `resourceId`, and
   * NOTHING in this platform preassigns one: every technician assignment on record
   * references the legacy bay instead. So this method used to answer "no impact"
   * for every resource, including the only alignment bay in the building, on a week
   * with alignment appointments booked. Zero rows is not zero impact.
   *
   * The honest question is about the CAPABILITY, not the row: if this resource
   * stopped being usable, how many positions could still do this kind of work, and
   * what is already booked that needs it?
   */
  async impact(id: string) {
    const resource = await this.prisma.workResource.findUnique({
      where: { id },
      include: { occupancy: true, serviceCapabilities: { select: { capability: true } } },
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
      capabilityImpact: await this.capabilityImpact(
        id,
        resource.serviceCapabilities.map((c) => c.capability),
      ),
    };
  }

  /**
   * §14/§15 — the part of the impact a row count cannot see.
   *
   * Deliberately NOT precise. It does not claim an appointment will be delayed,
   * because that depends on duration, arrival order and manual dispatch, none of
   * which this method models. It states two checkable facts — how many positions
   * would remain, and what is already booked that needs this kind of work — and
   * says plainly when the configuration is too incomplete to be trusted.
   */
  private async capabilityImpact(id: string, capabilities: string[]) {
    if (capabilities.length === 0) return [];
    const now = new Date();
    const horizonDays = 30;
    const horizon = new Date(now.getTime() + horizonDays * 86_400_000);

    // §12 — an unclassified resource may well serve these capabilities. If any
    // exist, every "remaining positions" figure below is a lower bound, and the
    // warnings must say so rather than implying a complete inventory.
    const unverified = await this.prisma.workResource.count({
      where: { capacityRole: 'UNVERIFIED', retiredAt: null, isActive: true, resourceCategory: { not: 'EXTERNAL' } },
    });

    const usable = await this.prisma.workResource.findMany({
      where: {
        retiredAt: null,
        isActive: true,
        schedulingEnabled: true,
        capacityRole: { in: ['PRIMARY_SERVICE_POSITION', 'OVERFLOW_SERVICE_POSITION'] },
        serviceCapabilities: { some: { capability: { in: capabilities } } },
      },
      select: {
        id: true,
        capacity: true,
        operationalStatus: { select: { status: true } },
        serviceCapabilities: { select: { capability: true } },
      },
    });
    // Absence of a status row means AVAILABLE — `setStatus` upserts only on change.
    const availableNow = usable.filter((r) => (r.operationalStatus?.status ?? 'AVAILABLE') === 'AVAILABLE');

    const booked = await this.prisma.$queryRaw<Array<{ capability: string; appointments: bigint }>>`
      SELECT st.required_bay_type AS capability, count(DISTINCT a.id) AS appointments
      FROM appointments a
      JOIN appointment_services asv ON asv.appointment_id = a.id
      JOIN service_types st ON st.id = asv.service_type_id
      WHERE a.status IN ('CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS')
        AND a.scheduled_start_at BETWEEN ${now} AND ${horizon}
        AND st.required_bay_type = ANY(${capabilities})
      GROUP BY 1
    `;
    const bookedBy = new Map(booked.map((b) => [b.capability, Number(b.appointments)]));

    return capabilities.map((capability) => {
      const has = (r: { serviceCapabilities: Array<{ capability: string }> }) =>
        r.serviceCapabilities.some((c) => c.capability === capability);
      const positionsBefore = availableNow.filter(has).reduce((n, r) => n + r.capacity, 0);
      const positionsAfter = availableNow.filter((r) => r.id !== id && has(r)).reduce((n, r) => n + r.capacity, 0);
      const futureAppointmentsNeeding = bookedBy.get(capability) ?? 0;

      const severity =
        positionsAfter === 0 ? ('LAST_POSITION' as const) : positionsAfter < positionsBefore ? ('REDUCED' as const) : ('NONE' as const);
      const parts: string[] = [];
      if (severity === 'LAST_POSITION') {
        parts.push(
          `This is the only position currently able to do ${capability} work. Taking it out leaves none.`,
        );
      } else if (severity === 'REDUCED') {
        parts.push(`${capability} positions would go from ${positionsBefore} to ${positionsAfter}.`);
      }
      if (futureAppointmentsNeeding > 0 && severity !== 'NONE') {
        parts.push(
          `${futureAppointmentsNeeding} appointment${futureAppointmentsNeeding === 1 ? '' : 's'} in the next ${horizonDays} days need${futureAppointmentsNeeding === 1 ? 's' : ''} ${capability}. ` +
            'Whether any of them is actually delayed depends on timing and dispatch, which this check does not model — review them rather than assuming either way.',
        );
      }
      if (unverified > 0 && severity !== 'NONE') {
        parts.push(
          `PHYSICAL CAPACITY REQUIRES CONFIRMATION — ${unverified} resources are still unclassified, so the remaining count is a lower bound.`,
        );
      }
      return {
        capability,
        positionsBefore,
        positionsAfter,
        futureAppointmentsNeeding,
        horizonDays,
        severity,
        warning: parts.length > 0 ? parts.join(' ') : null,
      };
    });
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
