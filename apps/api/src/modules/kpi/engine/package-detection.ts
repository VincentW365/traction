/**
 * CR-2026-088 / CR-2026-090 — which benchmark package does this job represent?
 *
 * Detection works off an administrator-controlled mapping of service-type IDs to
 * component ROLES, never off the service's displayed name. Names get edited — the
 * catalogue admin screen lets a manager rename "Disc Pad Change" tomorrow — and a
 * KPI benchmark that silently stops matching because someone fixed a typo is worse
 * than no benchmark at all.
 *
 * A job is benchmarked only when its services map EXACTLY onto one of the manager's
 * three approved packages. Anything else is CUSTOM_UNBENCHMARKED. It is deliberately
 * not "closest match": inventing a benchmark by summing catalogue times would produce
 * a number nobody agreed to and then rate a technician against it.
 *
 * v2 adds three things the flat service -> component map could not express:
 *
 *   ALIASES          Several catalogue codes can mean the same component. DISC-01
 *                    and BRK-02 both describe front pad work. Both map to
 *                    FRONT_BRAKES, and the component counts ONCE even if both are on
 *                    the order — one set of pads earns one brake allowance.
 *
 *   ABSORBED WORK    Activities the general-service standard already contains (oil
 *                    filter, air filter, wipers). They add no component and no time,
 *                    and crucially they must not knock the job out of its benchmark
 *                    just for being booked as separate lines.
 *
 *   AXLE QUALIFIER   Traction's brake codes carry no axle, but the shop's price list
 *                    distinguishes front from rear explicitly. A brake line is
 *                    therefore ambiguous on its own, and rear-only work must never
 *                    silently satisfy a standard built for front brakes.
 *
 * Pure functions. No database, no clock.
 */

/** The three components the benchmark matrix is built from. */
export type KpiPackageComponent = 'GENERAL_SERVICE' | 'FRONT_BRAKES' | 'SPARK_PLUGS';

/** What a mapped service means. Mirrors the `KpiComponentRole` enum. */
export type KpiComponentRole =
  | 'GENERAL_SERVICE_CORE'
  | 'FRONT_BRAKES'
  | 'SPARK_PLUGS'
  | 'INCLUDED_NO_ADDITIONAL_BENCHMARK'
  | 'FORCES_CUSTOM_BENCHMARK';

export type AxlePosition = 'FRONT' | 'REAR' | 'FRONT_AND_REAR' | 'NOT_APPLICABLE';

export type KpiPackageType =
  | 'GENERAL_SERVICE_ONLY'
  | 'GENERAL_SERVICE_FRONT_BRAKES'
  | 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS'
  | 'CUSTOM_UNBENCHMARKED';

export const KPI_PACKAGE_LABELS: Record<KpiPackageType, string> = {
  GENERAL_SERVICE_ONLY: 'General Service',
  GENERAL_SERVICE_FRONT_BRAKES: 'General Service + Front Brakes',
  GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS:
    'General Service + Front Brakes + Spark Plugs',
  CUSTOM_UNBENCHMARKED: 'Custom (not benchmarked)',
};

/** One active mapping row, as configured by an administrator. */
export interface ComponentMapping {
  componentRole: KpiComponentRole;
  /** When true, an unqualified line cannot satisfy the component. */
  requiresAxleQualifier: boolean;
}

/** serviceTypeId -> its active mapping. */
export type PackageComponentMap = ReadonlyMap<string, ComponentMapping>;

/** One service line on the work order. */
export interface ServiceLine {
  serviceTypeId: string;
  axlePosition?: AxlePosition | null;
}

export interface PackageDetectionOptions {
  /**
   * Whether a line covering BOTH axles may satisfy the Front Brakes component.
   *
   * Off by default and resolved from business-rule config, never hard-coded: a
   * front-and-rear job is more work than the standard was built for, so counting it
   * as a plain front-brake package rates the technician against a benchmark that
   * never included the rear axle. Management can approve it, but must do so
   * deliberately.
   */
  frontAndRearSatisfiesFrontBrakes?: boolean;
}

export interface PackageDetectionResult {
  packageType: KpiPackageType;
  /** Components present, in canonical order. */
  components: KpiPackageComponent[];
  /** Service-type IDs on the job that map to no component at all. */
  unmappedServiceTypeIds: string[];
  /** Mapped as absorbed by the general-service standard — present but not counted. */
  absorbedServiceTypeIds: string[];
  /** Explicitly mapped as work the approved packages do not describe. */
  forcesCustomServiceTypeIds: string[];
  /** Qualifier-requiring lines with no axle recorded. Actionable: staff can fix these. */
  awaitingAxleQualifierServiceTypeIds: string[];
  /** Qualifier-requiring lines whose axle does not satisfy the component (e.g. rear-only). */
  disqualifiedByAxleServiceTypeIds: string[];
  /**
   * True when the only thing standing between this job and a benchmark is an
   * unrecorded axle. Lets the UI prompt for the one field that would fix it, rather
   * than reporting a dead end.
   */
  resolvableByAxleQualifier: boolean;
  reason: string | null;
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

/** The manager's three approved packages, keyed by their exact component set. */
const APPROVED_PACKAGES: Array<{
  components: KpiPackageComponent[];
  packageType: KpiPackageType;
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

/**
 * Does this axle value satisfy a qualifier-requiring component?
 *
 * Split out so the rule is stated once and is readable on its own.
 */
function axleSatisfies(
  axle: AxlePosition | null | undefined,
  frontAndRearApproved: boolean,
): 'YES' | 'AWAITING' | 'NO' {
  if (axle === null || axle === undefined) return 'AWAITING';
  if (axle === 'FRONT') return 'YES';
  if (axle === 'FRONT_AND_REAR') return frontAndRearApproved ? 'YES' : 'NO';
  // REAR, and NOT_APPLICABLE on a line whose whole point is which axle it is.
  return 'NO';
}

/**
 * Classify a job's services into a benchmark package.
 *
 * @param lines        every service line on the work order (duplicates are fine).
 * @param componentMap the administrator-configured mapping.
 */
export function detectPackage(
  lines: readonly ServiceLine[],
  componentMap: PackageComponentMap,
  options: PackageDetectionOptions = {},
): PackageDetectionResult {
  const empty = {
    components: [] as KpiPackageComponent[],
    unmappedServiceTypeIds: [] as string[],
    absorbedServiceTypeIds: [] as string[],
    forcesCustomServiceTypeIds: [] as string[],
    awaitingAxleQualifierServiceTypeIds: [] as string[],
    disqualifiedByAxleServiceTypeIds: [] as string[],
    resolvableByAxleQualifier: false,
  };

  if (lines.length === 0) {
    return {
      ...empty,
      packageType: 'CUSTOM_UNBENCHMARKED',
      reason: 'The job has no services on it.',
    };
  }

  const frontAndRearApproved = options.frontAndRearSatisfiesFrontBrakes === true;

  const present = new Set<KpiPackageComponent>();
  const unmapped: string[] = [];
  const absorbed: string[] = [];
  const forcesCustom: string[] = [];
  const awaitingAxle: string[] = [];
  const disqualifiedByAxle: string[] = [];

  // Collapse duplicate lines for the same service, keeping the most specific axle
  // seen. Two lines of the same service are one component either way, and a job
  // should not be blocked for a missing axle on a duplicate row when a sibling row
  // already states it.
  const byService = new Map<string, AxlePosition | null>();
  for (const line of lines) {
    const existing = byService.get(line.serviceTypeId);
    const incoming = line.axlePosition ?? null;
    byService.set(
      line.serviceTypeId,
      existing === undefined || existing === null ? incoming : existing,
    );
  }

  for (const [serviceTypeId, axle] of byService) {
    const mapping = componentMap.get(serviceTypeId);

    if (!mapping) {
      unmapped.push(serviceTypeId);
      continue;
    }

    if (mapping.componentRole === 'INCLUDED_NO_ADDITIONAL_BENCHMARK') {
      absorbed.push(serviceTypeId);
      continue;
    }

    if (mapping.componentRole === 'FORCES_CUSTOM_BENCHMARK') {
      forcesCustom.push(serviceTypeId);
      continue;
    }

    const component = ROLE_TO_COMPONENT[mapping.componentRole];
    if (!component) {
      unmapped.push(serviceTypeId);
      continue;
    }

    if (mapping.requiresAxleQualifier) {
      const verdict = axleSatisfies(axle, frontAndRearApproved);
      if (verdict === 'AWAITING') {
        awaitingAxle.push(serviceTypeId);
        continue;
      }
      if (verdict === 'NO') {
        disqualifiedByAxle.push(serviceTypeId);
        continue;
      }
    }

    // Set semantics are what make aliases safe: DISC-01 and BRK-02 both land here as
    // FRONT_BRAKES and the component is still counted once.
    present.add(component);
  }

  const components = CANONICAL_ORDER.filter((c) => present.has(c));

  const base = {
    components,
    unmappedServiceTypeIds: unmapped,
    absorbedServiceTypeIds: absorbed,
    forcesCustomServiceTypeIds: forcesCustom,
    awaitingAxleQualifierServiceTypeIds: awaitingAxle,
    disqualifiedByAxleServiceTypeIds: disqualifiedByAxle,
  };

  // Reasons are collected rather than short-circuited, because a supervisor looking
  // at an unbenchmarked job needs the whole picture — fixing one blocker only to be
  // shown the next one is how "why is this not rated?" becomes a support ticket.
  const blockers: string[] = [];

  if (unmapped.length > 0) {
    blockers.push(
      `${unmapped.length} service(s) on this job are not mapped to any benchmark component.`,
    );
  }
  if (forcesCustom.length > 0) {
    blockers.push(
      `${forcesCustom.length} service(s) are additional work outside the approved packages.`,
    );
  }
  if (disqualifiedByAxle.length > 0) {
    blockers.push(
      frontAndRearApproved
        ? 'Rear-axle brake work does not satisfy the Front Brakes standard.'
        : 'Brake work is not front-axle only, and front-and-rear jobs are not approved to use the Front Brakes standard.',
    );
  }
  if (awaitingAxle.length > 0) {
    blockers.push(
      `${awaitingAxle.length} brake service(s) have no axle recorded, so the job cannot be matched to a package yet.`,
    );
  }

  // The axle is the ONLY thing missing: recording it would let the job benchmark.
  const resolvableByAxleQualifier =
    awaitingAxle.length > 0 &&
    unmapped.length === 0 &&
    forcesCustom.length === 0 &&
    disqualifiedByAxle.length === 0;

  if (blockers.length > 0) {
    return {
      ...base,
      packageType: 'CUSTOM_UNBENCHMARKED',
      resolvableByAxleQualifier,
      reason: blockers.join(' '),
    };
  }

  const match = APPROVED_PACKAGES.find(
    (p) =>
      p.components.length === components.length &&
      p.components.every((c) => present.has(c)),
  );

  if (!match) {
    return {
      ...base,
      packageType: 'CUSTOM_UNBENCHMARKED',
      resolvableByAxleQualifier: false,
      reason:
        components.length === 0
          ? 'None of this job’s services map to a benchmark component.'
          : `${components.join(' + ')} is not one of the three approved packages.`,
    };
  }

  return {
    ...base,
    packageType: match.packageType,
    resolvableByAxleQualifier: false,
    reason: null,
  };
}

/** Is this package one the manager has set a standard time for? */
export function isBenchmarked(packageType: KpiPackageType): boolean {
  return packageType !== 'CUSTOM_UNBENCHMARKED';
}
