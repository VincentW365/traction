import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { KpiComponentRole } from './engine/package-detection';

/**
 * CR-2026-090 — administration of the KPI package-component mapping.
 *
 * CR-2026-088 shipped this mapping as seed data with no screen, which made the one
 * genuinely configurable part of the KPI framework the one part only a developer
 * could change. This is that screen's backend.
 *
 * Two rules shape everything here:
 *
 *  1. A mapping is never deleted or edited in place once jobs have been measured
 *     under it. Changing it retrospectively would alter what a completed job was
 *     rated against, which is the exact failure the effective-dated policy was built
 *     to prevent. Changes SUPERSEDE: the old row is closed off and a new one opens.
 *
 *  2. Exactly one active mapping per service at a time. Two active mappings for one
 *     service would make detection depend on row order.
 */

export interface UpsertMappingInput {
  serviceTypeId: string;
  componentRole: KpiComponentRole;
  requiresAxleQualifier?: boolean;
  notes?: string;
  /** When the new mapping takes effect. Defaults to now; never backdated before the row it supersedes. */
  effectiveFrom?: Date;
}

const ROLE_LABELS: Record<KpiComponentRole, string> = {
  GENERAL_SERVICE_CORE: 'General Service (core)',
  FRONT_BRAKES: 'Front Brakes',
  SPARK_PLUGS: 'Spark Plugs',
  INCLUDED_NO_ADDITIONAL_BENCHMARK: 'Included — no additional time',
  FORCES_CUSTOM_BENCHMARK: 'Additional work — job not benchmarked',
};

const VALID_ROLES = Object.keys(ROLE_LABELS) as KpiComponentRole[];

/** Roles that define a benchmark component, as opposed to describing other work. */
const BENCHMARK_ROLES: KpiComponentRole[] = [
  'GENERAL_SERVICE_CORE',
  'FRONT_BRAKES',
  'SPARK_PLUGS',
];

@Injectable()
export class KpiMappingService {
  private readonly logger = new Logger(KpiMappingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  static readonly ROLE_LABELS = ROLE_LABELS;

  /**
   * Every service with its current mapping, plus what the screen needs to explain
   * itself: which services share a component (aliases), which are unmapped, and
   * whether a mapping can still be changed freely.
   */
  async list(includeHistory = false) {
    const now = new Date();

    const [services, mappings, usageCounts] = await Promise.all([
      this.prisma.serviceType.findMany({
        select: { id: true, code: true, name: true, family: true, isActive: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.kpiServiceComponent.findMany({
        orderBy: { effectiveFrom: 'desc' },
        include: {
          serviceType: { select: { code: true, name: true } },
        },
      }),
      this.prisma.serviceOrderItem.groupBy({
        by: ['serviceTypeId'],
        _count: { _all: true },
      }),
    ]);

    const usageByService = new Map(
      usageCounts.map((u) => [u.serviceTypeId, u._count._all]),
    );

    const activeByService = new Map<string, (typeof mappings)[number]>();
    for (const m of mappings) {
      if (!m.isActive) continue;
      if (m.effectiveFrom > now) continue;
      if (m.effectiveTo && m.effectiveTo <= now) continue;
      if (!activeByService.has(m.serviceTypeId)) activeByService.set(m.serviceTypeId, m);
    }

    // Aliases: several services resolving to the same benchmark component. Surfaced
    // explicitly because it is the single most confusing thing about this screen —
    // a manager needs to see that DISC-01 and BRK-02 are two doors into one room,
    // not two separate allowances.
    const aliasGroups = new Map<string, string[]>();
    for (const [serviceTypeId, m] of activeByService) {
      if (!BENCHMARK_ROLES.includes(m.componentRole as KpiComponentRole)) continue;
      const list = aliasGroups.get(m.componentRole) ?? [];
      list.push(serviceTypeId);
      aliasGroups.set(m.componentRole, list);
    }

    // Resolved across every mapping, not just the active ones, so the history block
    // below carries names too.
    const authors = await this.resolveAuthors(mappings.map((m) => m.updatedByUserId));

    const rows = services.map((s) => {
      const active = activeByService.get(s.id);
      const role = (active?.componentRole ?? null) as KpiComponentRole | null;
      const siblings = role ? (aliasGroups.get(role) ?? []).filter((id) => id !== s.id) : [];

      return {
        serviceTypeId: s.id,
        code: s.code,
        name: s.name,
        family: s.family,
        serviceIsActive: s.isActive,
        mappingId: active?.id ?? null,
        componentRole: role,
        componentRoleLabel: role ? ROLE_LABELS[role] : null,
        requiresAxleQualifier: active?.requiresAxleQualifier ?? false,
        effectiveFrom: active?.effectiveFrom ?? null,
        notes: active?.notes ?? null,
        updatedByUserId: active?.updatedByUserId ?? null,
        // Null means seeded, not anonymous — the screen says so rather than showing a UUID.
        updatedByName: active?.updatedByUserId
          ? (authors.get(active.updatedByUserId) ?? null)
          : null,
        /** Other services that resolve to the same benchmark component. */
        aliasOf: siblings
          .map((id) => services.find((x) => x.id === id)?.code)
          .filter((c): c is string => !!c),
        /** How many work-order lines have ever used this service. */
        timesUsed: usageByService.get(s.id) ?? 0,
        /** Unmapped services force jobs to CUSTOM_UNBENCHMARKED — surfaced as outstanding work. */
        needsReview: !active,
      };
    });

    return {
      rows,
      // Every historical row for every service, so opt-in only. A screen showing one
      // service's history at a time should use the dedicated endpoint instead — this
      // payload grows without bound as mappings accumulate.
      history: includeHistory
        ? mappings.map((m) => ({
            id: m.id,
            serviceTypeId: m.serviceTypeId,
            code: m.serviceType.code,
            name: m.serviceType.name,
            componentRole: m.componentRole,
            componentRoleLabel: ROLE_LABELS[m.componentRole as KpiComponentRole],
            requiresAxleQualifier: m.requiresAxleQualifier,
            isActive: m.isActive,
            effectiveFrom: m.effectiveFrom,
            effectiveTo: m.effectiveTo,
            notes: m.notes,
            updatedByUserId: m.updatedByUserId,
            updatedByName: m.updatedByUserId
              ? (authors.get(m.updatedByUserId) ?? null)
              : null,
          }))
        : undefined,
      roles: VALID_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
      unmappedCount: rows.filter((r) => r.needsReview && r.serviceIsActive).length,
    };
  }

  /**
   * The mapping history for one service, newest first.
   *
   * Shaped like the rows in `list()` — same field names, same role label, same
   * resolved author — so a client can render either without a second code path.
   */
  async history(serviceTypeId: string) {
    const rows = await this.prisma.kpiServiceComponent.findMany({
      where: { serviceTypeId },
      orderBy: { effectiveFrom: 'desc' },
      include: { serviceType: { select: { code: true, name: true } } },
    });

    const authors = await this.resolveAuthors(rows.map((r) => r.updatedByUserId));

    return rows.map((m) => ({
      id: m.id,
      serviceTypeId: m.serviceTypeId,
      code: m.serviceType.code,
      name: m.serviceType.name,
      componentRole: m.componentRole,
      componentRoleLabel: ROLE_LABELS[m.componentRole as KpiComponentRole],
      requiresAxleQualifier: m.requiresAxleQualifier,
      isActive: m.isActive,
      effectiveFrom: m.effectiveFrom,
      effectiveTo: m.effectiveTo,
      notes: m.notes,
      updatedByUserId: m.updatedByUserId,
      updatedByName: m.updatedByUserId ? (authors.get(m.updatedByUserId) ?? null) : null,
    }));
  }

  /**
   * Resolve author IDs to names.
   *
   * Done here rather than left to the client, which would otherwise have to fetch the
   * whole staff list to put a name against a UUID. A mapping with no author is seeded
   * rather than anonymous, and the caller distinguishes the two by the null.
   */
  private async resolveAuthors(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => !!i))];
    if (unique.length === 0) return new Map();

    const users = await this.prisma.userAccount.findMany({
      where: { id: { in: unique } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  /**
   * Set (or change) the mapping for a service.
   *
   * The previous active mapping is closed off rather than overwritten, so a job
   * measured last month can still be explained by the mapping that was in force
   * then.
   */
  async upsert(input: UpsertMappingInput, actorUserId: string) {
    if (!VALID_ROLES.includes(input.componentRole)) {
      throw new BadRequestException(
        `Unknown component role "${input.componentRole}". Expected one of: ${VALID_ROLES.join(', ')}.`,
      );
    }

    const service = await this.prisma.serviceType.findUnique({
      where: { id: input.serviceTypeId },
      select: { id: true, code: true, name: true },
    });
    if (!service) {
      throw new NotFoundException(`Service type ${input.serviceTypeId} not found`);
    }

    const now = new Date();
    const effectiveFrom = input.effectiveFrom ?? now;

    // A mapping that takes effect in the past would change how already-completed jobs
    // classify. Snapshots protect finalised results, but in-flight jobs re-detect on
    // scope changes, so a backdated mapping is still a way to alter a live
    // measurement after seeing how it is going.
    if (effectiveFrom < now && effectiveFrom.getTime() < now.getTime() - 60_000) {
      throw new BadRequestException(
        'A mapping cannot be backdated. Set it to take effect now or in the future — ' +
          'backdating would change what jobs already in progress are measured against.',
      );
    }

    const current = await this.prisma.kpiServiceComponent.findFirst({
      where: {
        serviceTypeId: input.serviceTypeId,
        isActive: true,
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    const classificationUnchanged =
      current &&
      current.componentRole === (input.componentRole as never) &&
      current.requiresAxleQualifier === (input.requiresAxleQualifier ?? false);

    if (classificationUnchanged) {
      // The classification is the same, so there is nothing to supersede — nothing a
      // past job was measured against has moved. But the rationale may still have
      // been corrected, and silently discarding it would give the manager a success
      // message for an edit that did not happen. Update the note in place and audit it.
      const notesChanged =
        input.notes !== undefined && (input.notes || null) !== (current.notes || null);
      if (!notesChanged) return current;

      const updated = await this.prisma.kpiServiceComponent.update({
        where: { id: current.id },
        data: { notes: input.notes, updatedByUserId: actorUserId },
      });

      await this.audit.log({
        actorUserId,
        action: 'KPI_MAPPING_NOTE_UPDATED',
        entityType: 'KpiServiceComponent',
        entityId: current.id,
        beforeJson: { notes: current.notes },
        afterJson: { serviceCode: service.code, notes: input.notes },
      });

      return updated;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.kpiServiceComponent.update({
          where: { id: current.id },
          data: { isActive: false, effectiveTo: effectiveFrom, updatedByUserId: actorUserId },
        });
      }

      return tx.kpiServiceComponent.create({
        data: {
          serviceTypeId: input.serviceTypeId,
          componentRole: input.componentRole as never,
          requiresAxleQualifier: input.requiresAxleQualifier ?? false,
          notes: input.notes,
          effectiveFrom,
          isActive: true,
          updatedByUserId: actorUserId,
        },
      });
    });

    await this.audit.log({
      actorUserId,
      action: current ? 'KPI_MAPPING_CHANGED' : 'KPI_MAPPING_CREATED',
      entityType: 'KpiServiceComponent',
      entityId: result.id,
      beforeJson: current
        ? {
            componentRole: current.componentRole,
            requiresAxleQualifier: current.requiresAxleQualifier,
          }
        : undefined,
      afterJson: {
        serviceCode: service.code,
        componentRole: input.componentRole,
        requiresAxleQualifier: input.requiresAxleQualifier ?? false,
      },
      notes: input.notes,
    });

    this.logger.log(
      `KPI mapping ${current ? 'changed' : 'created'} for ${service.code}: ${input.componentRole}`,
    );
    return result;
  }

  /**
   * Stop a mapping from applying to new jobs.
   *
   * Deactivation, never deletion. The row stays so a completed job's classification
   * can still be explained, which is the whole reason mappings are effective-dated.
   */
  async deactivate(mappingId: string, actorUserId: string, reason?: string) {
    const existing = await this.prisma.kpiServiceComponent.findUnique({
      where: { id: mappingId },
      include: { serviceType: { select: { code: true } } },
    });
    if (!existing) throw new NotFoundException(`Mapping ${mappingId} not found`);
    if (!existing.isActive) return existing;

    const updated = await this.prisma.kpiServiceComponent.update({
      where: { id: mappingId },
      data: {
        isActive: false,
        effectiveTo: new Date(),
        updatedByUserId: actorUserId,
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'KPI_MAPPING_DEACTIVATED',
      entityType: 'KpiServiceComponent',
      entityId: mappingId,
      beforeJson: {
        serviceCode: existing.serviceType.code,
        componentRole: existing.componentRole,
      },
      notes: reason,
    });

    this.logger.log(
      `KPI mapping deactivated for ${existing.serviceType.code} by ${actorUserId}`,
    );
    return updated;
  }
}
