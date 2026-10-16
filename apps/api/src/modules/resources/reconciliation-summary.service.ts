/**
 * CR-2026-108 — the Stage 5C entry gate.
 *
 * STRICTLY READ-ONLY. It classifies nothing, links nothing, and infers no capacity
 * number. It reports what the physical walk actually established, and says plainly
 * when that is not yet enough to build a resource-aware engine on.
 *
 * The one arithmetic rule this file exists to enforce: capability pools are NOT
 * additive. A single bay that can do alignment, lube and general work appears in
 * three pools and is still one vehicle at a time. Adding the pools would turn six
 * real positions into fourteen imaginary ones — which is the same class of error
 * as counting a mobile jack as a bay, and it is how a shop ends up promising work
 * it cannot do. So the overlap is computed and published alongside every total.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { isBayResolved } from './resource-admin.service';

/** The five the CR names explicitly. Anything else is reported as "additional". */
const NAMED_CAPABILITIES = ['GENERAL', 'LUBE', 'ALIGNMENT', 'INSPECTION', 'TIRE'];

/** Roles that describe a vehicle position, as opposed to a tool or a plan. */
const POSITION_ROLES = ['PRIMARY_SERVICE_POSITION', 'OVERFLOW_SERVICE_POSITION'];

export interface CapabilityPool {
  capability: string;
  /** Confirmed positions carrying this capability, whatever their status today. */
  verifiedPositions: number;
  /** Of those, usable right now. */
  availableNow: number;
  /** Positions that carry ONLY this capability — genuinely dedicated to it. */
  exclusivePositions: number;
  /** Positions shared with at least one other kind of work. */
  sharedPositions: number;
  /** One of the five the CR names, vs a capability the shop added. */
  isNamedType: boolean;
  /** Which resources, so a manager can check the claim against the building. */
  resources: string[];
}

export interface ReconciliationSummary {
  generatedAt: string;
  /** Has the physical walk produced enough to build Stage 5C on? */
  readyForStage5C: boolean;
  /** What is still missing. Empty when ready. */
  blockers: string[];

  /** Items 1–5 and 11 — the position census. */
  positions: {
    verifiedPrimary: number;
    /** CR-2026-119 §5 — the dedicated wash bay, reported apart from the service positions. */
    verifiedWash: number;
    verifiedOverflow: number;
    supportEquipment: number;
    placeholders: number;
    temporarilyUnavailable: number;
    unverified: number;
    retired: number;
    /** Confirmed positions usable right now. The only figure resembling capacity. */
    activeNow: number;
  };

  /** Items 6 and 7 — named capabilities first, then anything the shop added. */
  capabilities: CapabilityPool[];

  /**
   * The guard against reading the table above as a shop total. Publishing the sum
   * next to the truth is deliberate: someone will add the column up, and this is
   * the sentence that stops them acting on it.
   */
  capabilityOverlap: {
    distinctPhysicalPositions: number;
    sumOfPoolCounts: number;
    multiCapabilityPositions: number;
    note: string;
  };

  /** Item 8 — who cannot take which vehicle. */
  vehicleRestrictions: Array<{
    code: string;
    name: string;
    restriction: 'SEDAN_ONLY' | 'SUV_ONLY' | 'MOBILE_JACK_SEDAN_RULE' | 'NO_VEHICLE_CLASS';
    detail: string;
  }>;

  /**
   * Item 9 — old bay records the walk has not accounted for.
   *
   * A bay is accounted for by being linked to its current resource OR by being
   * explicitly dispositioned as historical-only, replaced or retired. Only the
   * genuinely unresolved ones appear here, because the alternative was a gate that
   * pushed people into inventing links to make it go green.
   */
  unresolvedLegacyBays: Array<{ code: string; bayType: string; status: string; historicalAssignments: number }>;

  /** Resolved without a link, and why — the other half of item 9. */
  dispositionedLegacyBays: Array<{
    code: string;
    bayType: string;
    disposition: string;
    note: string | null;
    dispositionedAt: string | null;
    /** Unchanged, always. Dispositioning records a fact; it never edits history. */
    historicalAssignments: number;
  }>;

  /** Item 10 — resources with no legacy counterpart, i.e. the expansion. */
  expansion: {
    /** Only meaningful once every legacy bay is linked or dispositioned. */
    reconciliationComplete: boolean;
    note: string;
    resources: Array<{ code: string; name: string; capacityRole: string; capabilities: string[]; createdAt: string }>;
  };

  /**
   * Item 12 — does cleaning consume a mechanical position, or its own?
   *
   * This one does NOT resolve itself when the walk finishes. Configuration says
   * cleaning shares, because CLEAN-01 requires the same capability repairs do;
   * the building may say otherwise. Only management can close the gap, and the
   * fix is a catalogue change rather than a bay assignment.
   */
  vehicleCleaning: {
    serviceCode: string | null;
    requiredCapability: string | null;
    verdict: 'DEDICATED_POSITION' | 'SHARES_MECHANICAL_POSITION' | 'NO_VERIFIED_POSITION' | 'NOT_DETERMINED';
    detail: string;
    positions: string[];
    /** Open until management answers. Never closed by classifying bays. */
    managementConfirmation: {
      open: boolean;
      question: string;
      /** Described, deliberately not implemented — see `status`. */
      proposalIfDedicated: string;
      status: 'AWAITING_PHYSICAL_CONFIRMATION' | 'NOT_APPLICABLE';
    };
  };

  /** Item 13 — bookable today, and one bad day away from being unfulfillable. */
  singlePositionBookableServices: Array<{
    code: string;
    name: string;
    capability: string;
    verifiedPositions: number;
    severity: 'NO_POSITION' | 'SINGLE_POSITION';
    /**
     * VERIFIED means the walk is done and this is a real operational finding.
     * INCOMPLETE_CONFIGURATION means the count is low because nobody has
     * classified anything yet — a fact about the data, not about the shop, and
     * it must not be reported as though a customer cannot be served.
     */
    basis: 'VERIFIED' | 'INCOMPLETE_CONFIGURATION';
  }>;
}

@Injectable()
export class ReconciliationSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(siteId?: string): Promise<ReconciliationSummary> {
    const where = siteId ? { siteId } : {};
    const resources = await this.prisma.workResource.findMany({
      where,
      orderBy: [{ resourceCategory: 'asc' }, { code: 'asc' }],
      select: {
        id: true, code: true, name: true, resourceCategory: true, capacity: true,
        capacityRole: true, isActive: true, retiredAt: true, schedulingEnabled: true,
        supportsSedan: true, supportsSuv: true, liftType: true, legacyBayId: true,
        createdAt: true,
        operationalStatus: { select: { status: true } },
        serviceCapabilities: { select: { capability: true }, orderBy: { capability: 'asc' } },
      },
    });
    const bays = await this.prisma.workBay.findMany({
      where,
      orderBy: { code: 'asc' },
      select: {
        id: true, code: true, bayType: true, status: true,
        reconciliationDisposition: true, dispositionNote: true, dispositionedAt: true,
        resource: { select: { code: true } },
        _count: { select: { assignments: true } },
      },
    });

    type Row = (typeof resources)[number];
    const live = resources.filter((r) => !r.retiredAt);
    const status = (r: Row) => r.operationalStatus?.status ?? 'AVAILABLE';
    // A position is "usable now" only if it is active, scheduled and available.
    // Role and status are separate dimensions: MAINTENANCE does not reclassify.
    const usableNow = (r: Row) => r.isActive && r.schedulingEnabled && status(r) === 'AVAILABLE';
    const isPosition = (r: Row) => POSITION_ROLES.includes(String(r.capacityRole));
    const caps = (r: Row) => r.serviceCapabilities.map((c) => c.capability);

    const verifiedPositions = live.filter(isPosition);
    const activePositions = verifiedPositions.filter(usableNow);

    // --- items 1–5, 11 ------------------------------------------------------
    // CR-2026-119 §5 — a dedicated wash bay is a vehicle position (one car at a
    // time) but not a SERVICE position; counting it among the primaries would
    // make the workshop read as one mechanical bay bigger than it is. It is
    // reported on its own line instead of hidden.
    const isWash = (r: Row) => String(r.resourceCategory) === 'POWER_WASH';
    const positions = {
      verifiedPrimary: live.filter((r) => r.capacityRole === 'PRIMARY_SERVICE_POSITION' && !isWash(r)).length,
      verifiedWash: live.filter((r) => r.capacityRole === 'PRIMARY_SERVICE_POSITION' && isWash(r)).length,
      verifiedOverflow: live.filter((r) => r.capacityRole === 'OVERFLOW_SERVICE_POSITION').length,
      supportEquipment: live.filter((r) => r.capacityRole === 'SUPPORT_EQUIPMENT').length,
      placeholders: live.filter((r) => r.capacityRole === 'PLACEHOLDER').length,
      // Temporarily unavailable is a STATUS, so it deliberately overlaps the rows
      // above rather than replacing them — a maintenance bay is still a bay.
      temporarilyUnavailable: live.filter((r) => status(r) !== 'AVAILABLE').length,
      // EXTERNAL is excluded by category; leaving it unclassified is not a gap.
      unverified: live.filter(
        (r) => r.capacityRole === 'UNVERIFIED' && String(r.resourceCategory) !== 'EXTERNAL',
      ).length,
      retired: resources.length - live.length,
      activeNow: activePositions.reduce((n, r) => n + r.capacity, 0),
    };

    // --- items 6 & 7 --------------------------------------------------------
    const present = [...new Set(verifiedPositions.flatMap(caps))];
    const ordered = [
      ...NAMED_CAPABILITIES,
      ...present.filter((c) => !NAMED_CAPABILITIES.includes(c)).sort(),
    ];
    const capabilities: CapabilityPool[] = ordered.map((capability) => {
      const holders = verifiedPositions.filter((r) => caps(r).includes(capability));
      return {
        capability,
        verifiedPositions: holders.reduce((n, r) => n + r.capacity, 0),
        availableNow: holders.filter(usableNow).reduce((n, r) => n + r.capacity, 0),
        exclusivePositions: holders.filter((r) => caps(r).length === 1).length,
        sharedPositions: holders.filter((r) => caps(r).length > 1).length,
        isNamedType: NAMED_CAPABILITIES.includes(capability),
        resources: holders.map((r) => r.code),
      };
    });

    // --- the anti-additive guard -------------------------------------------
    const sumOfPoolCounts = capabilities.reduce((n, p) => n + p.verifiedPositions, 0);
    const distinctPhysicalPositions = verifiedPositions
      .filter((r) => caps(r).length > 0)
      .reduce((n, r) => n + r.capacity, 0);
    const multiCapability = verifiedPositions.filter((r) => caps(r).length > 1).length;

    // --- item 8 -------------------------------------------------------------
    const vehicleRestrictions: ReconciliationSummary['vehicleRestrictions'] = [];
    for (const r of live) {
      if (r.liftType === 'mobile') {
        vehicleRestrictions.push({
          code: r.code,
          name: r.name,
          restriction: 'MOBILE_JACK_SEDAN_RULE',
          detail:
            'Mobile jack — sedan-only under DMAIC Rule 3. A manager override exists and is audited, ' +
            'so this is a gate rather than a hard incompatibility.',
        });
        continue;
      }
      if (!r.supportsSedan && !r.supportsSuv) {
        vehicleRestrictions.push({
          code: r.code, name: r.name, restriction: 'NO_VEHICLE_CLASS',
          detail: 'Configured to accept neither sedans nor SUVs — no vehicle can be assigned here.',
        });
      } else if (!r.supportsSuv) {
        vehicleRestrictions.push({
          code: r.code, name: r.name, restriction: 'SEDAN_ONLY',
          detail: 'Sedans only. An SUV assignment is refused as plain incompatibility.',
        });
      } else if (!r.supportsSedan) {
        vehicleRestrictions.push({
          code: r.code, name: r.name, restriction: 'SUV_ONLY',
          detail: 'SUVs only. A sedan assignment is refused as plain incompatibility.',
        });
      }
    }

    // --- items 9 & 10 -------------------------------------------------------
    const unresolvedLegacyBays = bays
      .filter((b) => !isBayResolved(b))
      .map((b) => ({
        code: b.code, bayType: b.bayType, status: b.status,
        historicalAssignments: b._count.assignments,
      }));
    const dispositionedLegacyBays = bays
      .filter((b) => String(b.reconciliationDisposition) !== 'UNRESOLVED')
      .map((b) => ({
        code: b.code,
        bayType: b.bayType,
        disposition: String(b.reconciliationDisposition),
        note: b.dispositionNote,
        dispositionedAt: b.dispositionedAt?.toISOString() ?? null,
        historicalAssignments: b._count.assignments,
      }));
    const reconciliationComplete = unresolvedLegacyBays.length === 0;
    const expansionRows = live.filter((r) => !r.legacyBayId);

    // --- item 12 ------------------------------------------------------------
    const cleaning = await this.prisma.serviceType.findFirst({
      where: { code: 'CLEAN-01' },
      select: { code: true, name: true, requiredBayType: true },
    });
    // Whether cleaning has a position of its own is decided in the CATALOGUE
    // before it is decided in the building: if the capability cleaning asks for
    // is the same one repairs ask for, then no amount of bay configuration makes
    // a wash position dedicated. It is a repair bay with a hose.
    const competingServices = cleaning?.requiredBayType
      ? await this.prisma.serviceType.count({
          where: { isActive: true, requiredBayType: cleaning.requiredBayType, code: { not: cleaning.code } },
        })
      : 0;
    const vehicleCleaning = this.cleaningVerdict(cleaning, competingServices, verifiedPositions, caps);

    // --- item 13 ------------------------------------------------------------
    const bookable = await this.prisma.serviceType.findMany({
      where: { bookableOnline: true, isActive: true, requiredBayType: { not: null } },
      orderBy: { code: 'asc' },
      select: { code: true, name: true, customerFacingName: true, requiredBayType: true },
    });
    // The walk is what makes these numbers mean anything. Until it is done, a
    // pool of zero says nobody has classified a bay — not that nobody can do
    // the work — and the two must not be printed in the same words.
    const walkComplete = positions.unverified === 0 && reconciliationComplete;
    const singlePositionBookableServices = bookable
      .map((s) => {
        const capability = s.requiredBayType!;
        const pool = capabilities.find((p) => p.capability === capability);
        const verified = pool?.verifiedPositions ?? 0;
        return {
          code: s.code,
          name: s.customerFacingName?.trim() || s.name,
          capability,
          verifiedPositions: verified,
          severity: verified === 0 ? ('NO_POSITION' as const) : ('SINGLE_POSITION' as const),
          basis: walkComplete ? ('VERIFIED' as const) : ('INCOMPLETE_CONFIGURATION' as const),
        };
      })
      .filter((s) => s.verifiedPositions <= 1);

    // --- readiness ----------------------------------------------------------
    const blockers: string[] = [];
    if (positions.unverified > 0) {
      blockers.push(
        `${positions.unverified} resource${positions.unverified === 1 ? '' : 's'} still unclassified — ` +
          'so every count here describes part of the shop.',
      );
    }
    if (!reconciliationComplete) {
      const withHistory = unresolvedLegacyBays.filter((b) => b.historicalAssignments > 0);
      blockers.push(
        `${unresolvedLegacyBays.length} legacy bay record${unresolvedLegacyBays.length === 1 ? '' : 's'} not yet accounted for` +
          (withHistory.length > 0
            ? ` (${withHistory.map((b) => `${b.code}: ${b.historicalAssignments} jobs`).join(', ')}) — ` +
              'these are the records scheduling has actually been using. '
            : '. ') +
          'Each needs either a link to the resource that IS that position, or a note saying it is history — ' +
          'do not invent a link to clear this.',
      );
    }
    if (verifiedPositions.length === 0) {
      blockers.push('No confirmed vehicle positions — there is nothing for a resource-aware engine to reason about.');
    } else if (capabilities.every((p) => p.verifiedPositions === 0)) {
      blockers.push('Positions are confirmed but none carries a capability — every pool would be empty.');
    }
    // Only raised once the walk is done. Before that it would restate the
    // "unclassified" blocker in alarming language the data does not support.
    const noPosition = singlePositionBookableServices.filter((s) => s.severity === 'NO_POSITION');
    if (walkComplete && noPosition.length > 0) {
      blockers.push(
        `${noPosition.map((s) => `${s.code} (${s.capability})`).join(', ')} ${noPosition.length === 1 ? 'is' : 'are'} ` +
          'bookable online with no verified position able to do the work.',
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      readyForStage5C: blockers.length === 0,
      blockers,
      positions,
      capabilities,
      capabilityOverlap: {
        distinctPhysicalPositions,
        sumOfPoolCounts,
        multiCapabilityPositions: multiCapability,
        note:
          sumOfPoolCounts > distinctPhysicalPositions
            ? `Adding the capability column gives ${sumOfPoolCounts}; the shop has ${distinctPhysicalPositions} physical positions. ` +
              `${multiCapability} position${multiCapability === 1 ? '' : 's'} carry more than one capability and are counted once per pool. ` +
              'Capability totals are NOT additive shop capacity — each pool answers "how many positions could take this kind of work", ' +
              'and two of them cannot both be busy on the same position at the same time.'
            : 'No position carries more than one capability, so the pools happen not to overlap today. ' +
              'They are still not additive by construction — treat that as a coincidence of the current configuration, not a rule.',
      },
      vehicleRestrictions,
      unresolvedLegacyBays,
      dispositionedLegacyBays,
      expansion: {
        reconciliationComplete,
        note: reconciliationComplete
          ? 'Every legacy bay is linked or accounted for, so a resource with no link is genuinely new capacity.'
          : 'Legacy reconciliation is incomplete, so this list mixes genuine expansion with resources nobody has dealt with yet. ' +
            'It becomes authoritative once the bays above are linked or dispositioned.',
        resources: expansionRows.map((r) => ({
          code: r.code,
          name: r.name,
          capacityRole: String(r.capacityRole),
          capabilities: caps(r),
          createdAt: r.createdAt.toISOString(),
        })),
      },
      vehicleCleaning,
      singlePositionBookableServices,
    };
  }

  /**
   * §12 — cleaning is asked about separately because the answer changes what
   * every other number means. If Vehicle Cleaning happens in a mechanical bay,
   * a booked wash is a repair position no longer available for repairs.
   */
  private cleaningVerdict<T extends { code: string }>(
    service: { code: string; name: string; requiredBayType: string | null } | null,
    competingServices: number,
    positions: T[],
    caps: (r: T) => string[],
  ): ReconciliationSummary['vehicleCleaning'] {
    /**
     * The question management has to answer, and what would follow from a yes.
     * Carried on every verdict except the one where cleaning already has its own
     * capability, because until then no amount of bay classification closes it.
     */
    const open = (): ReconciliationSummary['vehicleCleaning']['managementConfirmation'] => ({
      open: true,
      question:
        'Does Vehicle Cleaning have a physical position of its own — a wash bay that is not also used for repairs — ' +
        'or does it happen in a mechanical service position?',
      proposalIfDedicated:
        'If the walk confirms a dedicated cleaning position: add CLEANING as an additive service/resource capability, ' +
        'assign it to that position only, and remap CLEAN-01 from its current capability to CLEANING. ' +
        'Additive — no existing capability, service or historical record changes, and the remap is a public-catalogue ' +
        'change requiring approval. NOT implemented: proposed only, and only after physical confirmation.',
      status: 'AWAITING_PHYSICAL_CONFIRMATION',
    });
    const closed = (): ReconciliationSummary['vehicleCleaning']['managementConfirmation'] => ({
      open: false,
      question: 'Does Vehicle Cleaning have a physical position of its own?',
      proposalIfDedicated: 'Already answered in configuration — cleaning has a capability of its own.',
      status: 'NOT_APPLICABLE',
    });

    if (!service || !service.requiredBayType) {
      return {
        serviceCode: service?.code ?? null,
        requiredCapability: null,
        verdict: 'NOT_DETERMINED',
        detail: service
          ? `${service.code} has no required capability set, so where cleaning physically happens cannot be read from configuration.`
          : 'No CLEAN-01 service found in the catalogue.',
        positions: [],
        managementConfirmation: open(),
      };
    }
    const capability = service.requiredBayType;
    const holders = positions.filter((r) => caps(r).includes(capability));
    if (holders.length === 0) {
      return {
        serviceCode: service.code,
        requiredCapability: capability,
        verdict: 'NO_VERIFIED_POSITION',
        detail: `No confirmed position carries ${capability}, so nothing yet says where Vehicle Cleaning happens.`,
        positions: [],
        managementConfirmation: open(),
      };
    }
    // The catalogue decides this before the bays do. If other services ask for
    // the same capability, every position that can wash a car can also be asked
    // to repair one, and no configuration of bays changes that.
    if (competingServices > 0) {
      return {
        serviceCode: service.code,
        requiredCapability: capability,
        verdict: 'SHARES_MECHANICAL_POSITION',
        detail:
          `Vehicle Cleaning requires ${capability}, and ${competingServices} other active service${competingServices === 1 ? '' : 's'} ` +
          `require${competingServices === 1 ? 's' : ''} the same capability. Every position that can take a wash ` +
          `(${holders.map((r) => r.code).join(', ')}) can therefore be called on for repairs instead — a booked cleaning ` +
          'occupies repair capacity, and Stage 5C must model it that way UNLESS the walk says otherwise. ' +
          'This is what CONFIGURATION says, not what the building says: giving cleaning a position of its own ' +
          'requires a capability of its own, which is a catalogue change and therefore management\'s call. ' +
          'Classifying bays cannot close this one.',
        positions: holders.map((r) => r.code),
        managementConfirmation: open(),
      };
    }

    // The capability belongs to cleaning alone, so any position carrying it is
    // genuinely dedicated to it.
    return {
      serviceCode: service.code,
      requiredCapability: capability,
      verdict: 'DEDICATED_POSITION',
      detail:
        `${capability} is required by Vehicle Cleaning and by nothing else, and ${holders.map((r) => r.code).join(', ')} ` +
        `carr${holders.length === 1 ? 'ies' : 'y'} it. A booked cleaning does not consume a repair position.`,
      positions: holders.map((r) => r.code),
      managementConfirmation: closed(),
    };
  }
}
