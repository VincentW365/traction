/**
 * CR-2026-108 Stage 5A — the Resource Truth Audit.
 *
 * STRICTLY READ-ONLY. It changes nothing and proposes everything.
 *
 * The question it exists to answer is not "what rows are in the resources table"
 * but "how many vehicles can this shop actually work on at once" — and a database
 * cannot know that. Rows were created when the platform was configured; whether
 * BAY-06 is a commissioned bay or a note-to-self, and whether a mobile jack is a
 * work position or a tool used AT one, are facts only management holds.
 *
 * So every classification here is a PROPOSAL with a confirmation flag, and the
 * output is a sheet a person signs off. Nothing derived here may become
 * production capacity without that.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * What a resource contributes to simultaneous vehicle capacity.
 *
 * These are EXACTLY the values of the `ResourceCapacityRole` enum, deliberately:
 * the audit's job is to propose a role that can actually be stored, so a second,
 * richer vocabulary here would produce proposals nobody can apply.
 *
 * §2 — note what is NOT in this list. "Out of service" and "external" are real
 * facts about a resource, but they are not capacity ROLES: a primary bay under
 * maintenance is still a primary bay, it simply contributes nothing today. They
 * live on `ResourceOperationalStatus` and `resourceCategory` respectively, and
 * are reported through `excludedFromCapacity` rather than by overwriting the role.
 */
export type CapacityRole =
  /** Nobody has classified it yet — zero capacity, and NOT a statement of fact. */
  | 'UNVERIFIED'
  /** Independently holds one vehicle being worked on. */
  | 'PRIMARY_SERVICE_POSITION'
  /** A genuine extra vehicle position, available only in defined circumstances. */
  | 'OVERFLOW_SERVICE_POSITION'
  /** Enables work but creates no additional simultaneous vehicle position. */
  | 'SUPPORT_EQUIPMENT'
  /** Configured but unproven — must contribute ZERO until verified. */
  | 'PLACEHOLDER';

/** Why a resource contributes nothing today, independently of its role. */
export type CapacityExclusion =
  /** Not this shop's capacity at all — `resourceCategory = EXTERNAL`. */
  | 'EXTERNAL'
  /** Retired, deactivated, or removed from scheduling. */
  | 'NOT_IN_SERVICE'
  /** A live operational status other than AVAILABLE. */
  | 'UNAVAILABLE_TODAY';

export interface ResourceAuditRow {
  code: string;
  name: string;
  category: string;
  configuredCapacity: number;
  isActive: boolean;
  schedulingEnabled: boolean;
  operationalStatus: string;
  supportsSedan: boolean;
  supportsSuv: boolean;
  requiresMechanic: boolean;
  liftType: string | null;
  maxVehicleWeight: string | null;
  /** What is STORED today. UNVERIFIED until someone confirms. */
  capacityRole: CapacityRole;
  /** Capabilities configured on this physical resource. */
  capabilities: string[];
  /** The legacy WorkBay this supersedes, when reconciliation has linked them. */
  linkedLegacyBay: { code: string; bayType: string; historicalAssignments: number } | null;
  /** Deterministic suggestion for an UNVERIFIED row — never applied. */
  proposedRole: CapacityRole;
  /** Set when something other than the role is keeping this out of capacity. */
  excludedFromCapacity: CapacityExclusion | null;
  /** Would this count toward simultaneous capacity under the proposal? */
  countsTowardCapacity: boolean;
  /** Why the proposal says what it says. */
  rationale: string;
  /** True when a person must confirm before this can be trusted. */
  needsConfirmation: boolean;
  /** Real scheduling usage, as evidence of whether the row is live at all. */
  usage: { assignmentsByResource: number; reservations: number; occupancyState: string };
}

export interface TechnicianReliability {
  activeAccounts: number;
  inactiveAccounts: number;
  shiftRecords: number;
  hasShiftData: boolean;
  skillRows: number;
  distinctSkills: number;
  /** Skills held by nearly everyone — no discriminating power. */
  undifferentiatedSkills: string[];
  /** Skills held by only one or two — potentially real specialisms. */
  scarceSkills: Array<{ skill: string; technicians: number }>;
  substantiatedConcurrentTechnicians: number | null;
  assessment: string;
}

export interface ResourceTruthAudit {
  generatedAt: string;
  resources: ResourceAuditRow[];
  summary: {
    configuredRows: number;
    proposedPrimary: number;
    proposedOverflow: number;
    proposedSupportEquipment: number;
    proposedPlaceholder: number;
    /** What the RESOURCES capacity mode would compute today, unaudited. */
    naiveResourcesModeCapacity: number;
    /** What the proposal would compute instead. */
    proposedVerifiedCapacity: number;
    /** What production actually uses right now. */
    productionFixedCapacity: number;
  };
  /** Two resource models exist; this reports which one scheduling really uses. */
  modelDivergence: {
    workResourceRows: number;
    legacyWorkBayRows: number;
    assignmentsUsingWorkResource: number;
    assignmentsUsingLegacyBay: number;
    note: string;
  };
  /** Service demand vs bays that exist, in the vocabulary the catalogue uses. */
  bayTypeCoverage: Array<{ bayType: string; servicesRequiring: number; pilotServicesRequiring: number; activeBays: number; shortfall: boolean }>;
  technicians: TechnicianReliability;
  /** Questions only management can answer. */
  confirmationsRequired: string[];
  /**
   * CR-2026-108 Stage 5B — capacity DERIVED from configuration, never entered.
   * Adding a bay raises it; maintenance lowers it; no key is edited, no deploy.
   */
  derived: {
    verifiedActivePositions: number;
    unverifiedResources: number;
    /** True while any resource is unclassified — the numbers describe part of a shop. */
    configurationIncomplete: boolean;
    incompleteWarning: string | null;
    /** Eligible positions per kind of work, from capabilities. */
    capabilityPools: Array<{
      capability: string;
      eligiblePositions: number;
      servicesRequiring: number;
      pilotServicesRequiring: number;
      /**
       * MEASURED once every resource is classified. Until then LOWER_BOUND: an
       * unclassified bay may well serve this capability, so the count can only
       * rise. §15 — say which it is rather than implying a precision we lack.
       */
      confidence: 'MEASURED' | 'LOWER_BOUND';
      /** Two overlapping bookings could exceed this today under FIXED. */
      doubleBookingRisk: boolean;
    }>;
  };
}

/**
 * §16 — the order in which specialty pools are reported, scarcest first.
 *
 * ALIGNMENT is the one management raised, but it is not special: LUBE and
 * INSPECTION have exactly one bay each in the legacy inventory and carry the
 * same exposure. Vehicle cleaning has no bay type of its own — CLEAN-01 asks for
 * GENERAL — so it is reported inside that pool rather than invented as its own.
 * Anything not listed sorts last, alphabetically.
 */
const SPECIALTY_PRIORITY = ['ALIGNMENT', 'LUBE', 'INSPECTION', 'GENERAL', 'TIRE', 'DIAGNOSTIC'];
const specialtyRank = (capability: string): number => {
  const i = SPECIALTY_PRIORITY.indexOf(capability);
  return i === -1 ? SPECIALTY_PRIORITY.length : i;
};

/**
 * Only a CONFIRMED vehicle position contributes. UNVERIFIED and PLACEHOLDER
 * contribute nothing, and so does SUPPORT_EQUIPMENT — but they mean different
 * things, which is why they are separate values rather than one "no" flag.
 */
export function contributesCapacity(role: string): boolean {
  return role === 'PRIMARY_SERVICE_POSITION' || role === 'OVERFLOW_SERVICE_POSITION';
}

/**
 * Can it be used RIGHT NOW? Capacity role and operational status are separate
 * dimensions: a PRIMARY position under MAINTENANCE is still a primary position,
 * it just contributes nothing today.
 *
 * Absence of a ResourceOperationalStatus row means AVAILABLE — that is how
 * `resource-admin.setStatus()` behaves (it upserts only on change), so an empty
 * table means "nobody has changed anything", not "unconfigured".
 */
export function isUsableNow(r: {
  isActive: boolean;
  retiredAt: Date | null;
  schedulingEnabled: boolean;
  operationalStatus: { status: unknown } | null;
}): boolean {
  if (!r.isActive || r.retiredAt || !r.schedulingEnabled) return false;
  const status = r.operationalStatus?.status ? String(r.operationalStatus.status) : 'AVAILABLE';
  return status === 'AVAILABLE';
}

@Injectable()
export class ResourceTruthAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async audit(): Promise<ResourceTruthAudit> {
    const resources = await this.prisma.workResource.findMany({
      orderBy: [{ resourceCategory: 'asc' }, { code: 'asc' }],
      select: {
        id: true, code: true, name: true, resourceCategory: true, capacity: true,
        isActive: true, schedulingEnabled: true, supportsSedan: true, supportsSuv: true,
        requiresMechanic: true, liftType: true, maxVehicleWeight: true, retiredAt: true,
        capacityRole: true,
        serviceCapabilities: { select: { capability: true }, orderBy: { capability: 'asc' } },
        legacyBay: { select: { code: true, bayType: true, _count: { select: { assignments: true } } } },
        operationalStatus: { select: { status: true } },
        // `occupancy` is one-to-one, so it is read rather than counted.
        occupancy: { select: { status: true } },
        _count: { select: { assignments: true, reservations: true } },
      },
    });

    const rows: ResourceAuditRow[] = resources.map((r) => {
      const { proposedRole, excludedFromCapacity, rationale, needsConfirmation } = this.classify(r);
      return {
        code: r.code,
        name: r.name,
        category: String(r.resourceCategory),
        configuredCapacity: r.capacity,
        isActive: r.isActive && !r.retiredAt,
        schedulingEnabled: r.schedulingEnabled,
        // §3 — `resource-admin.setStatus()` upserts only when a status CHANGES, so
        // the absence of a row means nobody has ever taken this resource out of
        // service. That is AVAILABLE; the Stage 5A "NOT CONFIGURED" wording was wrong.
        operationalStatus: r.operationalStatus?.status ? String(r.operationalStatus.status) : 'AVAILABLE',
        supportsSedan: r.supportsSedan,
        supportsSuv: r.supportsSuv,
        requiresMechanic: r.requiresMechanic,
        liftType: r.liftType,
        maxVehicleWeight: r.maxVehicleWeight ? String(r.maxVehicleWeight) : null,
        capacityRole: r.capacityRole,
        capabilities: r.serviceCapabilities.map((c) => c.capability),
        linkedLegacyBay: r.legacyBay
          ? { code: r.legacyBay.code, bayType: r.legacyBay.bayType, historicalAssignments: r.legacyBay._count.assignments }
          : null,
        proposedRole,
        excludedFromCapacity,
        // Capacity comes from what is STORED, never from the suggestion. A
        // heuristic must not be able to create production capacity.
        countsTowardCapacity: contributesCapacity(String(r.capacityRole)) && isUsableNow(r),
        rationale,
        needsConfirmation,
        usage: {
          assignmentsByResource: r._count.assignments,
          reservations: r._count.reservations,
          occupancyState: r.occupancy?.status ? String(r.occupancy.status) : 'none',
        },
      };
    });

    // What the existing RESOURCES capacity mode would total today, unaudited —
    // the number this audit exists to stop anyone adopting by accident.
    const etaCategories = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'booking_capacity_resource_categories', effectiveTo: null },
      select: { valueJson: true },
    });
    const categories = Array.isArray(etaCategories?.valueJson) ? (etaCategories.valueJson as string[]) : ['BAY', 'OVERFLOW'];
    const naive = resources
      .filter((r) => r.isActive && r.schedulingEnabled && categories.includes(String(r.resourceCategory)))
      .reduce((n, r) => n + r.capacity, 0);
    const fixed = await this.prisma.businessRuleConfig.findFirst({
      where: { ruleKey: 'booking_max_concurrent_appointments', effectiveTo: null },
      select: { valueJson: true },
    });

    return {
      generatedAt: new Date().toISOString(),
      resources: rows,
      summary: {
        configuredRows: rows.length,
        proposedPrimary: rows.filter((r) => r.proposedRole === 'PRIMARY_SERVICE_POSITION').length,
        proposedOverflow: rows.filter((r) => r.proposedRole === 'OVERFLOW_SERVICE_POSITION').length,
        proposedSupportEquipment: rows.filter((r) => r.proposedRole === 'SUPPORT_EQUIPMENT').length,
        proposedPlaceholder: rows.filter((r) => r.proposedRole === 'PLACEHOLDER').length,
        naiveResourcesModeCapacity: naive,
        proposedVerifiedCapacity: rows.filter((r) => r.countsTowardCapacity).reduce((n, r) => n + r.configuredCapacity, 0),
        productionFixedCapacity: typeof fixed?.valueJson === 'number' ? fixed.valueJson : 0,
      },
      modelDivergence: await this.modelDivergence(),
      bayTypeCoverage: await this.bayTypeCoverage(),
      technicians: await this.technicianReliability(),
      confirmationsRequired: CONFIRMATIONS,
      derived: await this.derivedCapacity(rows),
    };
  }

  /**
   * Deterministic proposal. Names and lift types are evidence, not proof — which
   * is exactly why everything uncertain carries `needsConfirmation`.
   */
  private classify(r: {
    code: string; name: string; resourceCategory: unknown; isActive: boolean; retiredAt: Date | null;
    schedulingEnabled: boolean; liftType: string | null; requiresMechanic: boolean;
    operationalStatus: { status: unknown } | null;
  }): { proposedRole: CapacityRole; excludedFromCapacity: CapacityExclusion | null; rationale: string; needsConfirmation: boolean } {
    const category = String(r.resourceCategory);
    const name = r.name.toLowerCase();

    // §2 — these answer "does it count TODAY", which is a different question from
    // "what kind of thing is it". Recording them as the ROLE would erase the
    // shop's classification the moment a bay went under maintenance, and then
    // silently restore an unverified one when it came back.
    const excludedFromCapacity: CapacityExclusion | null =
      category === 'EXTERNAL'
        ? 'EXTERNAL'
        : !r.isActive || r.retiredAt || !r.schedulingEnabled
          ? 'NOT_IN_SERVICE'
          : r.operationalStatus?.status && String(r.operationalStatus.status) !== 'AVAILABLE'
            ? 'UNAVAILABLE_TODAY'
            : null;
    const suffix =
      excludedFromCapacity === 'EXTERNAL'
        ? ' Excluded from capacity regardless of role: external provider.'
        : excludedFromCapacity === 'NOT_IN_SERVICE'
          ? ' Excluded from capacity regardless of role: inactive, retired, or removed from scheduling.'
          : excludedFromCapacity === 'UNAVAILABLE_TODAY'
            ? ` Excluded from capacity TODAY only: operational status ${String(r.operationalStatus?.status)}. The role still applies when it returns.`
            : '';
    const out = (proposedRole: CapacityRole, rationale: string, needsConfirmation: boolean) => ({
      proposedRole,
      excludedFromCapacity,
      rationale: rationale + suffix,
      needsConfirmation,
    });

    // An external row is somebody else's resource; classifying its physical role
    // is not this shop's call, so it stays UNVERIFIED rather than being forced
    // into a value that would misrepresent it.
    if (category === 'EXTERNAL') {
      return out('UNVERIFIED', 'External provider — this shop does not classify its positions.', false);
    }
    // "(TBD)" is the shop telling us it does not know yet. Take it literally.
    if (/\btbd\b|\bt\.b\.d\b/i.test(name)) {
      return out(
        'PLACEHOLDER',
        'Named TBD — contributes ZERO capacity until someone confirms it physically exists and is commissioned.',
        true,
      );
    }
    // A jack or a stand is a tool used AT a position, not a position. Counting
    // them is how one vehicle on one jack with two stands becomes four bookings.
    if (/\bjack\b|\bstand\b/i.test(name)) {
      return out(
        'SUPPORT_EQUIPMENT',
        'Reads as equipment used at a work position rather than an independent position. Counting it would inflate capacity — one vehicle on a jack with two stands must remain ONE vehicle.',
        true,
      );
    }
    if (category === 'OVERFLOW') {
      return out(
        'OVERFLOW_SERVICE_POSITION',
        'Configured as overflow. Whether it is a genuine vehicle position, and under what circumstances, needs confirming.',
        true,
      );
    }
    if (category === 'POWER_WASH') {
      return out(
        'PRIMARY_SERVICE_POSITION',
        'A wash location. If Vehicle Cleaning happens here rather than in a mechanical bay, cleaning stops competing for repair capacity — confirm.',
        true,
      );
    }
    if (category === 'LIGHT_SLOT' || !r.requiresMechanic) {
      return out(
        'SUPPORT_EQUIPMENT',
        'Needs no mechanic, so it is a holding/light-task location rather than a serviced position. Confirm whether work genuinely happens here.',
        true,
      );
    }
    return out('PRIMARY_SERVICE_POSITION', 'A lift/bay that appears to hold one vehicle independently.', true);
  }

  /**
   * CR-2026-108 Stage 5B §11 — capacity DERIVED from configuration, never typed.
   *
   * Nobody edits a number here. Commission a bay and classify it and this figure
   * rises on the next read; put one under maintenance and it falls; retire one
   * and it falls without deleting a single historical row. No business-rule key
   * is touched and nothing is redeployed.
   *
   * §12 — while ANY resource is still UNVERIFIED this describes a PART of the
   * shop, so it ships with an explicit incompleteness warning and must not be
   * adopted as production capacity.
   */
  private async derivedCapacity(rows: ResourceAuditRow[]): Promise<ResourceTruthAudit['derived']> {
    // Only a confirmed vehicle position that is usable today contributes, and it
    // contributes its own configured capacity rather than an assumed 1.
    const counting = rows.filter((r) => r.countsTowardCapacity);
    const verifiedActivePositions = counting.reduce((n, r) => n + r.configuredCapacity, 0);

    // An EXTERNAL row is excluded by category, so leaving it unclassified is not
    // a gap in this shop's configuration. Everything else unclassified is.
    const unverified = rows.filter((r) => r.capacityRole === 'UNVERIFIED' && r.excludedFromCapacity !== 'EXTERNAL');
    const configurationIncomplete = unverified.length > 0;

    // Demand, in the same vocabulary capabilities reuse (§8 — `requiredBayType`).
    const demand = await this.prisma.$queryRawUnsafe<Array<{ bay_type: string; services: number; pilot: number }>>(`
      SELECT st.required_bay_type AS bay_type,
             count(*)::int AS services,
             count(*) FILTER (WHERE st.bookable_online)::int AS pilot
      FROM service_types st
      WHERE st.is_active AND st.required_bay_type IS NOT NULL
      GROUP BY 1
    `);

    // §9 — a pool counts PHYSICAL POSITIONS. A resource carrying three
    // capabilities appears in three pools and is still one vehicle at a time,
    // which is exactly why these are reported as separate pools and never summed.
    const pools = demand
      .map((d) => {
        const eligiblePositions = counting
          .filter((r) => r.capabilities.includes(d.bay_type))
          .reduce((n, r) => n + r.configuredCapacity, 0);
        return {
          capability: d.bay_type,
          eligiblePositions,
          servicesRequiring: d.services,
          pilotServicesRequiring: d.pilot,
          confidence: configurationIncomplete ? ('LOWER_BOUND' as const) : ('MEASURED' as const),
          // Production FIXED capacity is 2, so two overlapping bookings are
          // already permitted. A pool of fewer than 2 can be oversold by the
          // engine that is running today — this is a live finding, not a forecast.
          doubleBookingRisk: d.pilot > 0 && eligiblePositions < 2,
        };
      })
      // §16 — scarcest specialties first. An unlisted capability sorts last
      // rather than first, which a bare indexOf of -1 would do.
      .sort((a, b) => specialtyRank(a.capability) - specialtyRank(b.capability) || a.capability.localeCompare(b.capability));

    return {
      verifiedActivePositions,
      unverifiedResources: unverified.length,
      configurationIncomplete,
      incompleteWarning: configurationIncomplete
        ? `Capacity configuration incomplete — ${unverified.length} of ${rows.length} resources have no confirmed capacity role. ` +
          `${verifiedActivePositions} describes only the part of the Service Centre that has been classified, and must not be adopted as production capacity. ` +
          'Capability pool counts are lower bounds for the same reason: an unclassified bay may well serve a pool it is not yet counted in.'
        : null,
      capabilityPools: pools,
    };
  }

  /** Two resource models exist. Which one does scheduling actually use? */
  private async modelDivergence(): Promise<ResourceTruthAudit['modelDivergence']> {
    const [workResourceRows, legacyWorkBayRows, byResource, byBay] = await Promise.all([
      this.prisma.workResource.count(),
      this.prisma.workBay.count(),
      this.prisma.technicianAssignment.count({ where: { resourceId: { not: null } } }),
      this.prisma.technicianAssignment.count({ where: { bayId: { not: null } } }),
    ]);
    return {
      workResourceRows,
      legacyWorkBayRows,
      assignmentsUsingWorkResource: byResource,
      assignmentsUsingLegacyBay: byBay,
      note:
        byResource === 0
          ? `No technician assignment has ever referenced a WorkResource; ${byBay} reference the legacy WorkBay table instead. ` +
            'A resource-aware engine reading WorkResource would therefore be reasoning about rows the shop has never actually used, ' +
            'while ServiceType.requiredBayType speaks the LEGACY vocabulary (GENERAL/LUBE/ALIGNMENT/...). Resolve which model is authoritative before building on either.'
          : `${byResource} assignments use WorkResource and ${byBay} use the legacy WorkBay table — both models are live.`,
    };
  }

  /** Demand in the vocabulary the catalogue actually speaks. */
  private async bayTypeCoverage(): Promise<ResourceTruthAudit['bayTypeCoverage']> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ bay_type: string; services: number; pilot: number; bays: number }>>(`
      SELECT st.required_bay_type AS bay_type,
             count(*)::int AS services,
             count(*) FILTER (WHERE st.bookable_online)::int AS pilot,
             (SELECT count(*)::int FROM work_bays b WHERE b.bay_type = st.required_bay_type AND b.status = 'ACTIVE') AS bays
      FROM service_types st
      WHERE st.is_active AND st.required_bay_type IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `);
    return rows.map((r) => ({
      bayType: r.bay_type,
      servicesRequiring: r.services,
      pilotServicesRequiring: r.pilot,
      activeBays: r.bays,
      shortfall: r.bays === 0 || (r.pilot > 0 && r.bays < 2),
    }));
  }

  /** §6 — can technician capacity be trusted as a scheduling constraint? */
  private async technicianReliability(): Promise<TechnicianReliability> {
    const [active, inactive, shifts, skills] = await Promise.all([
      this.prisma.technician.count({ where: { status: 'ACTIVE' } }),
      this.prisma.technician.count({ where: { status: { not: 'ACTIVE' } } }),
      this.prisma.mechanicDayAvailability.count(),
      this.prisma.technicianSkill.groupBy({ by: ['skillCode'], _count: { _all: true } }),
    ]);
    const undifferentiated = skills.filter((s) => s._count._all >= active * 0.7).map((s) => s.skillCode);
    const scarce = skills.filter((s) => s._count._all <= 2).map((s) => ({ skill: s.skillCode, technicians: s._count._all }));
    return {
      activeAccounts: active,
      inactiveAccounts: inactive,
      shiftRecords: shifts,
      hasShiftData: shifts > 0,
      skillRows: skills.reduce((n, s) => n + s._count._all, 0),
      distinctSkills: skills.length,
      undifferentiatedSkills: undifferentiated,
      scarceSkills: scarce,
      // Without shift data, the only defensible number is "unknown". An account
      // count is not an attendance record, and treating it as one would let the
      // engine promise work nobody is rostered to do.
      substantiatedConcurrentTechnicians: shifts > 0 ? null : null,
      assessment:
        shifts === 0
          ? `No shift or attendance data exists (0 rows). The platform does NOT know which technicians are on shift at any given time, so the maximum simultaneous technician count the data can substantiate is UNKNOWN — ${active} active accounts is a roster, not an attendance record. ` +
            `Skills cannot be used either: ${undifferentiated.length} of ${skills.length} skill codes are held by 70%+ of technicians, which is seeded breadth rather than a real skill matrix. ` +
            'Technician capacity must NOT become a limiting constraint in the resource-aware engine until shift data is maintained.'
          : `${shifts} availability records exist — assess coverage before relying on them.`,
    };
  }
}

/**
 * The questions the database cannot answer. Deliberately phrased as things a
 * person confirms, not as options a system infers from throughput.
 */
const CONFIRMATIONS: string[] = [
  'How many physical vehicles can actually be worked on at the same time?',
  'Which bays are operational today?',
  'Do Bays 6 and 7 physically exist, and are they commissioned?',
  'Are the two OVERFLOW slots genuine vehicle service positions, and under what circumstances?',
  'Are the mobile jacks (MJACK-01/02) independent work positions, or equipment used at a bay?',
  'Are the stands (STAND-01/02) independent work positions, or equipment used at a bay?',
  'How many ALIGNMENT positions exist? (The catalogue has one, and Wheel Alignment is a pilot service.)',
  'How many TIRE positions exist? (The catalogue requires a TIRE bay type that has no bay at all.)',
  'How many LUBE positions exist?',
  'Where does Vehicle Cleaning physically happen — a mechanical bay, or the Power Wash location?',
  'Where do Pre-Purchase Inspections physically happen?',
  'Which resources may substitute for GENERAL work?',
  'Are any resources unavailable at particular times of day or days of the week?',
  'Are technician shifts recorded anywhere outside this platform, and can they be maintained in it?',
];
