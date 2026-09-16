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

/** What a resource contributes to simultaneous vehicle capacity. */
export type CapacityRole =
  /** Independently holds one vehicle being worked on. */
  | 'PRIMARY_SERVICE_POSITION'
  /** A genuine extra vehicle position, available only in defined circumstances. */
  | 'OVERFLOW_SERVICE_POSITION'
  /** Enables work but creates no additional simultaneous vehicle position. */
  | 'SUPPORT_EQUIPMENT'
  /** Configured but unproven — must contribute ZERO until verified. */
  | 'PLACEHOLDER_TBD'
  /** Normally valid capacity, temporarily unavailable. */
  | 'OUT_OF_SERVICE'
  /** Not the Service Centre's capacity at all. */
  | 'EXTERNAL';

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
  /** Deterministic proposal — never applied. */
  proposedRole: CapacityRole;
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
        operationalStatus: { select: { status: true } },
        // `occupancy` is one-to-one, so it is read rather than counted.
        occupancy: { select: { status: true } },
        _count: { select: { assignments: true, reservations: true } },
      },
    });

    const rows: ResourceAuditRow[] = resources.map((r) => {
      const { proposedRole, rationale, needsConfirmation } = this.classify(r);
      return {
        code: r.code,
        name: r.name,
        category: String(r.resourceCategory),
        configuredCapacity: r.capacity,
        isActive: r.isActive && !r.retiredAt,
        schedulingEnabled: r.schedulingEnabled,
        operationalStatus: r.operationalStatus?.status ? String(r.operationalStatus.status) : 'NOT CONFIGURED',
        supportsSedan: r.supportsSedan,
        supportsSuv: r.supportsSuv,
        requiresMechanic: r.requiresMechanic,
        liftType: r.liftType,
        maxVehicleWeight: r.maxVehicleWeight ? String(r.maxVehicleWeight) : null,
        proposedRole,
        countsTowardCapacity: proposedRole === 'PRIMARY_SERVICE_POSITION' || proposedRole === 'OVERFLOW_SERVICE_POSITION',
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
        proposedPlaceholder: rows.filter((r) => r.proposedRole === 'PLACEHOLDER_TBD').length,
        naiveResourcesModeCapacity: naive,
        proposedVerifiedCapacity: rows.filter((r) => r.countsTowardCapacity).reduce((n, r) => n + r.configuredCapacity, 0),
        productionFixedCapacity: typeof fixed?.valueJson === 'number' ? fixed.valueJson : 0,
      },
      modelDivergence: await this.modelDivergence(),
      bayTypeCoverage: await this.bayTypeCoverage(),
      technicians: await this.technicianReliability(),
      confirmationsRequired: CONFIRMATIONS,
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
  }): { proposedRole: CapacityRole; rationale: string; needsConfirmation: boolean } {
    const category = String(r.resourceCategory);
    const name = r.name.toLowerCase();

    if (category === 'EXTERNAL') {
      return { proposedRole: 'EXTERNAL', rationale: 'External provider — not this shop\'s capacity.', needsConfirmation: false };
    }
    if (!r.isActive || r.retiredAt) {
      return { proposedRole: 'OUT_OF_SERVICE', rationale: 'Inactive or retired.', needsConfirmation: false };
    }
    if (r.operationalStatus?.status && String(r.operationalStatus.status) !== 'AVAILABLE') {
      return { proposedRole: 'OUT_OF_SERVICE', rationale: `Operational status ${String(r.operationalStatus.status)}.`, needsConfirmation: false };
    }
    // "(TBD)" is the shop telling us it does not know yet. Take it literally.
    if (/\btbd\b|\bt\.b\.d\b/i.test(name)) {
      return {
        proposedRole: 'PLACEHOLDER_TBD',
        rationale: 'Named TBD — contributes ZERO capacity until someone confirms it physically exists and is commissioned.',
        needsConfirmation: true,
      };
    }
    // A jack or a stand is a tool used AT a position, not a position. Counting
    // them is how one vehicle on one jack with two stands becomes four bookings.
    if (/\bjack\b|\bstand\b/i.test(name)) {
      return {
        proposedRole: 'SUPPORT_EQUIPMENT',
        rationale: 'Reads as equipment used at a work position rather than an independent position. Counting it would inflate capacity — one vehicle on a jack with two stands must remain ONE vehicle.',
        needsConfirmation: true,
      };
    }
    if (category === 'OVERFLOW') {
      return {
        proposedRole: 'OVERFLOW_SERVICE_POSITION',
        rationale: 'Configured as overflow. Whether it is a genuine vehicle position, and under what circumstances, needs confirming.',
        needsConfirmation: true,
      };
    }
    if (category === 'POWER_WASH') {
      return {
        proposedRole: 'PRIMARY_SERVICE_POSITION',
        rationale: 'A wash location. If Vehicle Cleaning happens here rather than in a mechanical bay, cleaning stops competing for repair capacity — confirm.',
        needsConfirmation: true,
      };
    }
    if (category === 'LIGHT_SLOT' || !r.requiresMechanic) {
      return {
        proposedRole: 'SUPPORT_EQUIPMENT',
        rationale: 'Needs no mechanic, so it is a holding/light-task location rather than a serviced position. Confirm whether work genuinely happens here.',
        needsConfirmation: true,
      };
    }
    return {
      proposedRole: 'PRIMARY_SERVICE_POSITION',
      rationale: 'A lift/bay that appears to hold one vehicle independently.',
      needsConfirmation: true,
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
