/**
 * CR-2026-092 — what each service on a work order contributes to the job's standard.
 *
 * This replaces a model that had exactly two answers: the service identifies one of
 * the manager's three packages, or it makes the whole job custom and unrateable. Most
 * real work is neither of those, and forcing it into one of them is what left ordinary
 * jobs without a benchmark:
 *
 *   a fuel filter        genuine extra technician time — should EXTEND the standard
 *   a tyre-pressure check already inside the General Service allowance — adds nothing,
 *                        and must not knock the job out of its package
 *   quotation prep       not technician repair time at all — neither extends the
 *                        standard nor voids it
 *
 * Two rules run through everything here:
 *
 *   A MANAGER PACKAGE REQUIRES GENERAL SERVICE. Front-brake work on its own is not
 *   "General Service + Front Brakes". It is a brake repair, measured against the
 *   brake catalogue time. Giving it the package allowance would hand a technician
 *   ninety minutes of general-service time they were never asked to spend.
 *
 *   A COMPONENT IS COUNTED ONCE. Several catalogue codes describe front pad work, and
 *   a job carrying two of them still fitted one set of pads.
 *
 * Pure functions. No database, no clock.
 */

export type KpiContributionMode =
  | 'PACKAGE_COMPONENT'
  | 'INCLUDED_IN_BASE'
  | 'ADDITIVE_STANDARD'
  | 'SEPARATE_SLA'
  | 'CONDITIONAL'
  | 'CUSTOM_ONLY';

export type KpiDurationSource =
  | 'MANAGER_PACKAGE'
  | 'SERVICE_CATALOG_DURATION'
  | 'FIXED_CONFIGURED_DURATION'
  | 'NO_DURATION';

export type KpiAllowanceBasis = 'PER_JOB' | 'PER_SERVICE_LINE' | 'PER_UNIT';

export type KpiRequiredQualifier = 'NONE' | 'BRAKE' | 'TIRE_OPERATION';

export type KpiPackageComponent = 'GENERAL_SERVICE' | 'FRONT_BRAKES' | 'SPARK_PLUGS';

export type KpiComponentRole =
  | 'GENERAL_SERVICE_CORE'
  | 'FRONT_BRAKES'
  | 'SPARK_PLUGS'
  | 'INCLUDED_NO_ADDITIONAL_BENCHMARK'
  | 'FORCES_CUSTOM_BENCHMARK';

export type AxlePosition = 'FRONT' | 'REAR' | 'FRONT_AND_REAR' | 'NOT_APPLICABLE';
export type BrakeAxle = 'FRONT' | 'REAR';
export type BrakeWorkType =
  | 'PADS'
  | 'SHOES'
  | 'ROTOR_OR_DISC'
  | 'FLUID_OR_BLEED'
  | 'INSPECTION_ONLY'
  | 'OTHER';
export type TireOperation =
  | 'PRESSURE_OR_TREAD_CHECK'
  | 'ROTATION'
  | 'BALANCE'
  | 'ALIGNMENT'
  | 'PUNCTURE_REPAIR'
  | 'REPLACEMENT'
  | 'OTHER_PHYSICAL_WORK';

export type VehicleClass = 'SEDAN_CLASS' | 'SUV_CLASS';

export type KpiBenchmarkSource =
  | 'MANAGER_PACKAGE'
  | 'MANAGER_PACKAGE_PLUS_ADDITIVES'
  | 'CATALOG_COMPOSITE'
  | 'MANAGER_CUSTOM'
  | 'NOT_TECHNICIAN_RATED';

export type KpiPackageType =
  | 'GENERAL_SERVICE_ONLY'
  | 'GENERAL_SERVICE_FRONT_BRAKES'
  | 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS'
  | 'CUSTOM_UNBENCHMARKED';

/** The administrator-configured policy for one service. */
export interface ContributionPolicy {
  contributionMode: KpiContributionMode;
  componentRole: KpiComponentRole | null;
  durationSource: KpiDurationSource;
  fixedSedanMinutes: number | null;
  fixedSuvMinutes: number | null;
  allowanceBasis: KpiAllowanceBasis;
  requiredQualifier: KpiRequiredQualifier;
  provisionalDuration: boolean;
}

/** serviceTypeId -> its active policy. */
export type ContributionPolicyMap = ReadonlyMap<string, ContributionPolicy>;

/** One line on the work order, with everything the calculation needs. */
export interface WorkOrderLine {
  id: string;
  serviceTypeId: string;
  serviceCode: string;
  serviceName: string;
  /** The service's own catalogue duration. */
  catalogueMinutes: number | null;
  status: string;
  axlePosition?: AxlePosition | null;
  brakeWorkType?: BrakeWorkType | null;
  tireOperation?: TireOperation | null;
  unitQuantity?: number | null;
}

/**
 * Line states that count towards the benchmark.
 *
 * A line only earns the technician time when the work was actually authorised and
 * expected of them. Cancelled, declined and pending-approval lines are excluded: a
 * recommendation the customer turned down must not change what the technician is
 * measured against.
 *
 * PLANNED counts because it is the default for a line that is on the order and
 * expected to be done — it means "not yet started", not "not agreed".
 */
const NON_COUNTABLE_STATUSES = new Set([
  'CANCELLED',
  'CANCELED',
  'DECLINED',
  'REMOVED',
  'VOID',
  'VOIDED',
  'PENDING_APPROVAL',
  'AWAITING_APPROVAL',
  'DEFERRED',
]);

export function isCountableLine(status: string | null | undefined): boolean {
  if (!status) return true;
  return !NON_COUNTABLE_STATUSES.has(status.toUpperCase());
}

/** One resolved contribution — what a line actually does to the standard. */
export interface ResolvedContribution {
  lineId: string;
  serviceTypeId: string;
  serviceCode: string;
  serviceName: string;
  /** The mode AFTER a conditional has been resolved. Never CONDITIONAL. */
  mode: Exclude<KpiContributionMode, 'CONDITIONAL'>;
  component: KpiPackageComponent | null;
  minutes: number;
  /** How the qualifiers resolved, for display: "Front · Pads", "Tyre · Rotation". */
  qualifierLabel: string | null;
  provisional: boolean;
  /** Set when this contribution was suppressed as a duplicate of the same component. */
  suppressedAsDuplicate?: boolean;
  note: string | null;
}

export interface MissingQualifier {
  lineId: string;
  serviceCode: string;
  serviceName: string;
  requiredQualifier: KpiRequiredQualifier;
  message: string;
}

export interface StandardCalculation {
  packageType: KpiPackageType;
  benchmarkSource: KpiBenchmarkSource;
  components: KpiPackageComponent[];
  basePackageMinutes: number | null;
  additiveMinutes: number;
  finalStandardMinutes: number | null;
  contributions: ResolvedContribution[];
  missingQualifiers: MissingQualifier[];
  unmappedServiceTypeIds: string[];
  /** Configuration is missing — an outstanding task, not a conclusion. */
  requiresBenchmarkReview: boolean;
  /** Genuinely bespoke work that no catalogue standard describes. */
  hasCustomOnlyWork: boolean;
  reason: string | null;
  provisionalDurationsUsed: boolean;
}

const CANONICAL_ORDER: KpiPackageComponent[] = [
  'GENERAL_SERVICE',
  'FRONT_BRAKES',
  'SPARK_PLUGS',
];

const ROLE_TO_COMPONENT: Partial<Record<KpiComponentRole, KpiPackageComponent>> = {
  GENERAL_SERVICE_CORE: 'GENERAL_SERVICE',
  FRONT_BRAKES: 'FRONT_BRAKES',
  SPARK_PLUGS: 'SPARK_PLUGS',
};

const APPROVED_PACKAGES: Array<{
  components: KpiPackageComponent[];
  packageType: Exclude<KpiPackageType, 'CUSTOM_UNBENCHMARKED'>;
}> = [
  { components: ['GENERAL_SERVICE'], packageType: 'GENERAL_SERVICE_ONLY' },
  {
    components: ['GENERAL_SERVICE', 'FRONT_BRAKES'],
    packageType: 'GENERAL_SERVICE_FRONT_BRAKES',
  },
  {
    components: ['GENERAL_SERVICE', 'FRONT_BRAKES', 'SPARK_PLUGS'],
    packageType: 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS',
  },
];

export interface ResolveOptions {
  vehicleClass: VehicleClass | null;
  /** (class, packageType) -> standard minutes, from the effective policy. */
  packageStandard: (vehicleClass: VehicleClass, packageType: KpiPackageType) => number | null;
}

const BRAKE_WORK_LABEL: Record<BrakeWorkType, string> = {
  PADS: 'Pads',
  SHOES: 'Shoes',
  ROTOR_OR_DISC: 'Rotor / disc',
  FLUID_OR_BLEED: 'Fluid / bleed',
  INSPECTION_ONLY: 'Inspection only',
  OTHER: 'Other',
};

const TIRE_OP_LABEL: Record<TireOperation, string> = {
  PRESSURE_OR_TREAD_CHECK: 'Pressure / tread check',
  ROTATION: 'Rotation',
  BALANCE: 'Balance',
  ALIGNMENT: 'Alignment',
  PUNCTURE_REPAIR: 'Puncture repair',
  REPLACEMENT: 'Replacement',
  OTHER_PHYSICAL_WORK: 'Other physical work',
};

/** Minutes for a line, from whichever source its policy names. */
function durationFor(
  policy: ContributionPolicy,
  line: WorkOrderLine,
  vehicleClass: VehicleClass | null,
): number {
  let base: number;
  switch (policy.durationSource) {
    case 'SERVICE_CATALOG_DURATION':
      base = line.catalogueMinutes ?? 0;
      break;
    case 'FIXED_CONFIGURED_DURATION':
      // Falls back to the sedan figure rather than to zero: additive services
      // deliberately carry one time for both classes until management approves a
      // split, and a missing SUV value means "not split yet", not "no work".
      base =
        (vehicleClass === 'SUV_CLASS'
          ? (policy.fixedSuvMinutes ?? policy.fixedSedanMinutes)
          : policy.fixedSedanMinutes) ?? 0;
      break;
    case 'MANAGER_PACKAGE':
    case 'NO_DURATION':
    default:
      return 0;
  }

  // PER_UNIT is the only basis that multiplies, and only where the catalogue prices
  // the work per unit. Quadrupling a whole-job rotation because a car has four
  // wheels is the mistake this exists to prevent.
  if (policy.allowanceBasis === 'PER_UNIT') {
    const units = line.unitQuantity ?? 1;
    return base * Math.max(1, units);
  }
  return base;
}

/**
 * Resolve a CONDITIONAL brake line into one or more concrete contributions.
 *
 * FRONT_AND_REAR produces TWO: front pads and rear shoes are different work with
 * different allowances, and collapsing them into a single ambiguous contribution is
 * how a two-axle job ends up measured as a one-axle one.
 */
function resolveBrakeLine(
  line: WorkOrderLine,
  policy: ContributionPolicy,
  generalServicePresent: boolean,
  vehicleClass: VehicleClass | null,
): { contributions: ResolvedContribution[]; missing: MissingQualifier | null } {
  const workType = line.brakeWorkType ?? null;
  const axle = line.axlePosition ?? null;

  // Inspection is the one brake activity whose axle genuinely does not matter.
  const axleNeeded = workType !== 'INSPECTION_ONLY';

  if (!workType || (axleNeeded && (axle == null || axle === 'NOT_APPLICABLE'))) {
    return {
      contributions: [],
      missing: {
        lineId: line.id,
        serviceCode: line.serviceCode,
        serviceName: line.serviceName,
        requiredQualifier: 'BRAKE',
        message: !workType
          ? `Choose the brake work type for ${line.serviceCode} — pads, shoes, rotor, fluid or inspection.`
          : `Choose which axle ${line.serviceCode} covers — front, rear, or both.`,
      },
    };
  }

  const catalogue = durationFor(policy, line, vehicleClass);

  if (workType === 'INSPECTION_ONLY') {
    return {
      contributions: [
        generalServicePresent
          ? {
              lineId: line.id,
              serviceTypeId: line.serviceTypeId,
              serviceCode: line.serviceCode,
              serviceName: line.serviceName,
              mode: 'INCLUDED_IN_BASE',
              component: null,
              minutes: 0,
              qualifierLabel: 'Inspection only',
              provisional: false,
              note: 'Inspection is part of the General Service allowance.',
            }
          : {
              lineId: line.id,
              serviceTypeId: line.serviceTypeId,
              serviceCode: line.serviceCode,
              serviceName: line.serviceName,
              mode: 'ADDITIVE_STANDARD',
              component: null,
              minutes: catalogue,
              qualifierLabel: 'Inspection only',
              provisional: policy.provisionalDuration,
              note: 'Standalone paid inspection — uses its catalogue standard.',
            },
      ],
      missing: null,
    };
  }

  const axles: BrakeAxle[] =
    axle === 'FRONT_AND_REAR' ? ['FRONT', 'REAR'] : [axle as BrakeAxle];

  const contributions = axles.map((a): ResolvedContribution => {
    const label = `${a === 'FRONT' ? 'Front' : 'Rear'} · ${BRAKE_WORK_LABEL[workType]}`;

    // Front PADS with a General Service is the manager's Front Brakes component. The
    // package already contains the front-brake allowance, so the catalogue time must
    // NOT be added on top — that would pay for the same work twice.
    if (a === 'FRONT' && workType === 'PADS' && generalServicePresent) {
      return {
        lineId: line.id,
        serviceTypeId: line.serviceTypeId,
        serviceCode: line.serviceCode,
        serviceName: line.serviceName,
        mode: 'PACKAGE_COMPONENT',
        component: 'FRONT_BRAKES',
        minutes: 0,
        qualifierLabel: label,
        provisional: false,
        note: 'Included in the Front Brakes package allowance.',
      };
    }

    // Everything else is genuine additional work measured on its own catalogue time:
    // front pads with no general service, rear pads, shoes, rotors, fluid.
    return {
      lineId: line.id,
      serviceTypeId: line.serviceTypeId,
      serviceCode: line.serviceCode,
      serviceName: line.serviceName,
      mode: 'ADDITIVE_STANDARD',
      component: null,
      minutes: catalogue,
      qualifierLabel: label,
      provisional: policy.provisionalDuration,
      note:
        a === 'FRONT' && workType === 'PADS'
          ? 'Front brake work with no General Service — measured on its own catalogue standard.'
          : null,
    };
  });

  return { contributions, missing: null };
}

/** Resolve a CONDITIONAL tyre line. */
function resolveTireLine(
  line: WorkOrderLine,
  policy: ContributionPolicy,
  generalServicePresent: boolean,
  vehicleClass: VehicleClass | null,
): { contributions: ResolvedContribution[]; missing: MissingQualifier | null } {
  const op = line.tireOperation ?? null;
  if (!op) {
    return {
      contributions: [],
      missing: {
        lineId: line.id,
        serviceCode: line.serviceCode,
        serviceName: line.serviceName,
        requiredQualifier: 'TIRE_OPERATION',
        message: `Choose the tyre operation for ${line.serviceCode} — a pressure check and a replacement are different jobs.`,
      },
    };
  }

  const label = `Tyre · ${TIRE_OP_LABEL[op]}`;
  const catalogue = durationFor(policy, line, vehicleClass);

  // The manager's General Service activity list already includes tyre-pressure
  // checking, so it adds nothing when the general service is present.
  if (op === 'PRESSURE_OR_TREAD_CHECK') {
    return {
      contributions: [
        generalServicePresent
          ? {
              lineId: line.id,
              serviceTypeId: line.serviceTypeId,
              serviceCode: line.serviceCode,
              serviceName: line.serviceName,
              mode: 'INCLUDED_IN_BASE',
              component: null,
              minutes: 0,
              qualifierLabel: label,
              provisional: false,
              note: 'Tyre-pressure checking is part of the General Service allowance.',
            }
          : {
              lineId: line.id,
              serviceTypeId: line.serviceTypeId,
              serviceCode: line.serviceCode,
              serviceName: line.serviceName,
              mode: 'ADDITIVE_STANDARD',
              component: null,
              minutes: catalogue,
              qualifierLabel: label,
              provisional: policy.provisionalDuration,
              note: 'Booked on its own — uses its catalogue standard.',
            },
      ],
      missing: null,
    };
  }

  return {
    contributions: [
      {
        lineId: line.id,
        serviceTypeId: line.serviceTypeId,
        serviceCode: line.serviceCode,
        serviceName: line.serviceName,
        mode: 'ADDITIVE_STANDARD',
        component: null,
        minutes: catalogue,
        qualifierLabel: label,
        provisional: policy.provisionalDuration,
        note: null,
      },
    ],
    missing: null,
  };
}

/**
 * Work out the job's final standard, and show the arithmetic.
 */
export function calculateStandard(
  allLines: readonly WorkOrderLine[],
  policies: ContributionPolicyMap,
  options: ResolveOptions,
): StandardCalculation {
  const empty: StandardCalculation = {
    packageType: 'CUSTOM_UNBENCHMARKED',
    benchmarkSource: 'NOT_TECHNICIAN_RATED',
    components: [],
    basePackageMinutes: null,
    additiveMinutes: 0,
    finalStandardMinutes: null,
    contributions: [],
    missingQualifiers: [],
    unmappedServiceTypeIds: [],
    requiresBenchmarkReview: false,
    hasCustomOnlyWork: false,
    reason: null,
    provisionalDurationsUsed: false,
  };

  const lines = allLines.filter((l) => isCountableLine(l.status));
  if (lines.length === 0) {
    return {
      ...empty,
      reason: allLines.length
        ? 'Every service on this job was cancelled, declined or is still awaiting approval.'
        : 'The job has no services on it.',
    };
  }

  const unmapped: string[] = [];

  // Pass 1 — is a General Service present? Conditionals depend on the answer, and the
  // General Service component itself is never conditional, so there is no circularity.
  let generalServicePresent = false;
  for (const line of lines) {
    const p = policies.get(line.serviceTypeId);
    if (!p) continue;
    if (
      p.contributionMode === 'PACKAGE_COMPONENT' &&
      ROLE_TO_COMPONENT[p.componentRole ?? 'FORCES_CUSTOM_BENCHMARK'] === 'GENERAL_SERVICE'
    ) {
      generalServicePresent = true;
      break;
    }
  }

  // Pass 2 — resolve every line into concrete contributions.
  const contributions: ResolvedContribution[] = [];
  const missingQualifiers: MissingQualifier[] = [];
  let hasCustomOnly = false;

  for (const line of lines) {
    const policy = policies.get(line.serviceTypeId);
    if (!policy) {
      unmapped.push(line.serviceTypeId);
      continue;
    }

    if (policy.contributionMode === 'CONDITIONAL') {
      const resolved =
        policy.requiredQualifier === 'BRAKE'
          ? resolveBrakeLine(line, policy, generalServicePresent, options.vehicleClass)
          : policy.requiredQualifier === 'TIRE_OPERATION'
            ? resolveTireLine(line, policy, generalServicePresent, options.vehicleClass)
            : {
                contributions: [],
                missing: {
                  lineId: line.id,
                  serviceCode: line.serviceCode,
                  serviceName: line.serviceName,
                  requiredQualifier: policy.requiredQualifier,
                  message: `${line.serviceCode} is configured as conditional but names no qualifier.`,
                },
              };
      if (resolved.missing) missingQualifiers.push(resolved.missing);
      contributions.push(...resolved.contributions);
      continue;
    }

    if (policy.contributionMode === 'CUSTOM_ONLY') {
      hasCustomOnly = true;
      contributions.push({
        lineId: line.id,
        serviceTypeId: line.serviceTypeId,
        serviceCode: line.serviceCode,
        serviceName: line.serviceName,
        mode: 'CUSTOM_ONLY',
        component: null,
        minutes: 0,
        qualifierLabel: null,
        provisional: false,
        note: 'Bespoke work — no catalogue standard describes it.',
      });
      continue;
    }

    const component =
      policy.contributionMode === 'PACKAGE_COMPONENT'
        ? (ROLE_TO_COMPONENT[policy.componentRole ?? 'FORCES_CUSTOM_BENCHMARK'] ?? null)
        : null;

    contributions.push({
      lineId: line.id,
      serviceTypeId: line.serviceTypeId,
      serviceCode: line.serviceCode,
      serviceName: line.serviceName,
      mode: policy.contributionMode as Exclude<KpiContributionMode, 'CONDITIONAL'>,
      component,
      minutes:
        policy.contributionMode === 'ADDITIVE_STANDARD'
          ? durationFor(policy, line, options.vehicleClass)
          : 0,
      qualifierLabel: null,
      provisional:
        policy.contributionMode === 'ADDITIVE_STANDARD' && policy.provisionalDuration,
      note:
        policy.contributionMode === 'INCLUDED_IN_BASE'
          ? 'Already covered by the package standard.'
          : policy.contributionMode === 'SEPARATE_SLA'
            ? 'Tracked separately — not technician repair time.'
            : null,
    });
  }

  // A package component counted twice is one set of pads paid for twice. Aliases are
  // the usual cause; suppression is recorded rather than silent so the breakdown can
  // show why a line contributed nothing.
  const seenComponents = new Set<KpiPackageComponent>();
  for (const c of contributions) {
    if (c.mode !== 'PACKAGE_COMPONENT' || !c.component) continue;
    if (seenComponents.has(c.component)) {
      c.suppressedAsDuplicate = true;
      c.note = 'Same component as another line on this job — counted once.';
      continue;
    }
    seenComponents.add(c.component);
  }

  // An additive service is allowed once per job by default, however many lines carry
  // it. PER_SERVICE_LINE and PER_UNIT opt out of that.
  const perJobSeen = new Set<string>();
  for (const c of contributions) {
    if (c.mode !== 'ADDITIVE_STANDARD') continue;
    const policy = policies.get(c.serviceTypeId);
    if (!policy || policy.allowanceBasis !== 'PER_JOB') continue;
    // Two axles from one line are two distinct pieces of work, so they are keyed by
    // their qualifier rather than collapsed into one.
    const key = `${c.serviceTypeId}::${c.qualifierLabel ?? ''}`;
    if (perJobSeen.has(key)) {
      c.suppressedAsDuplicate = true;
      c.minutes = 0;
      c.note = 'Allowed once per job — already counted.';
      continue;
    }
    perJobSeen.add(key);
  }

  const componentsPresent = new Set<KpiPackageComponent>();
  for (const c of contributions) {
    if (c.mode === 'PACKAGE_COMPONENT' && c.component && !c.suppressedAsDuplicate) {
      componentsPresent.add(c.component);
    }
  }
  const components = CANONICAL_ORDER.filter((c) => componentsPresent.has(c));

  const additiveMinutes = contributions
    .filter((c) => c.mode === 'ADDITIVE_STANDARD' && !c.suppressedAsDuplicate)
    .reduce((sum, c) => sum + c.minutes, 0);

  const provisionalDurationsUsed = contributions.some(
    (c) => c.provisional && !c.suppressedAsDuplicate && c.minutes > 0,
  );

  const requiresBenchmarkReview = unmapped.length > 0 || missingQualifiers.length > 0;

  const blockers: string[] = [];
  if (unmapped.length > 0) {
    blockers.push(
      `${unmapped.length} service(s) on this job have no KPI contribution policy.`,
    );
  }
  if (missingQualifiers.length > 0) {
    blockers.push(missingQualifiers.map((m) => m.message).join(' '));
  }

  if (requiresBenchmarkReview) {
    return {
      ...empty,
      components,
      contributions,
      missingQualifiers,
      unmappedServiceTypeIds: unmapped,
      requiresBenchmarkReview: true,
      hasCustomOnlyWork: hasCustomOnly,
      additiveMinutes,
      reason: blockers.join(' '),
      provisionalDurationsUsed,
    };
  }

  if (hasCustomOnly) {
    return {
      ...empty,
      components,
      contributions,
      unmappedServiceTypeIds: [],
      hasCustomOnlyWork: true,
      additiveMinutes,
      benchmarkSource: 'NOT_TECHNICIAN_RATED',
      reason: 'This job includes bespoke work that no catalogue standard describes.',
      provisionalDurationsUsed,
    };
  }

  const technicianContributions = contributions.filter(
    (c) => c.mode !== 'SEPARATE_SLA' && !c.suppressedAsDuplicate,
  );
  if (technicianContributions.length === 0) {
    // Everything on the order was advisor activity. Real, tracked elsewhere, and not
    // something to rate a technician on.
    return {
      ...empty,
      contributions,
      benchmarkSource: 'NOT_TECHNICIAN_RATED',
      reason: 'Nothing on this job is technician repair work.',
    };
  }

  // A MANAGER PACKAGE REQUIRES GENERAL SERVICE.
  const packageMatch = componentsPresent.has('GENERAL_SERVICE')
    ? APPROVED_PACKAGES.find(
        (p) =>
          p.components.length === components.length &&
          p.components.every((c) => componentsPresent.has(c)),
      )
    : undefined;

  if (packageMatch && options.vehicleClass) {
    const base = options.packageStandard(options.vehicleClass, packageMatch.packageType);
    if (base != null) {
      return {
        packageType: packageMatch.packageType,
        benchmarkSource:
          additiveMinutes > 0 ? 'MANAGER_PACKAGE_PLUS_ADDITIVES' : 'MANAGER_PACKAGE',
        components,
        basePackageMinutes: base,
        additiveMinutes,
        finalStandardMinutes: base + additiveMinutes,
        contributions,
        missingQualifiers: [],
        unmappedServiceTypeIds: [],
        requiresBenchmarkReview: false,
        hasCustomOnlyWork: false,
        reason: null,
        provisionalDurationsUsed,
      };
    }
  }

  // No General Service, or components that are not one of the approved packages. The
  // job is still perfectly rateable — on the sum of the catalogue standards for the
  // work actually done. What it must NOT get is the package allowance.
  const catalogueTotal = technicianContributions.reduce((sum, c) => {
    if (c.mode === 'ADDITIVE_STANDARD') return sum + c.minutes;
    // A package component that did not form a package still represents real work, so
    // it contributes its own catalogue time here rather than nothing.
    if (c.mode === 'PACKAGE_COMPONENT') {
      const line = lines.find((l) => l.id === c.lineId);
      const policy = policies.get(c.serviceTypeId);
      if (line && policy) {
        return (
          sum +
          (policy.durationSource === 'MANAGER_PACKAGE'
            ? (line.catalogueMinutes ?? 0)
            : durationFor(policy, line, options.vehicleClass))
        );
      }
    }
    return sum;
  }, 0);

  if (catalogueTotal <= 0) {
    return {
      ...empty,
      components,
      contributions,
      benchmarkSource: 'NOT_TECHNICIAN_RATED',
      reason: 'No catalogue duration is configured for the work on this job.',
      provisionalDurationsUsed,
    };
  }

  return {
    packageType: 'CUSTOM_UNBENCHMARKED',
    benchmarkSource: 'CATALOG_COMPOSITE',
    components,
    basePackageMinutes: null,
    additiveMinutes,
    finalStandardMinutes: catalogueTotal,
    contributions,
    missingQualifiers: [],
    unmappedServiceTypeIds: [],
    requiresBenchmarkReview: false,
    hasCustomOnlyWork: false,
    reason: componentsPresent.has('GENERAL_SERVICE')
      ? null
      : 'No General Service on this job — measured against catalogue standards, not a package.',
    provisionalDurationsUsed,
  };
}

/** Is this job measured against something? */
export function isRateable(calc: StandardCalculation): boolean {
  return calc.finalStandardMinutes != null && calc.finalStandardMinutes > 0;
}

export { BRAKE_WORK_LABEL, TIRE_OP_LABEL };
