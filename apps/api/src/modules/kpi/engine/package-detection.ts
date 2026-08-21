/**
 * CR-2026-088 — which benchmark package does this job represent?
 *
 * Detection works off an administrator-controlled mapping of service-type IDs to
 * three components, never off the service's displayed name. Names get edited — the
 * catalogue admin screen lets a manager rename "Disc Pad Change" tomorrow — and a
 * KPI benchmark that silently stops matching because someone fixed a typo is worse
 * than no benchmark at all.
 *
 * The three components a manager configures:
 *
 *   GENERAL_SERVICE  — the routine service itself (oil, filters, fluid checks…)
 *   FRONT_BRAKES     — front brake work
 *   SPARK_PLUGS      — spark plug replacement
 *
 * A job is benchmarked only when its services map EXACTLY onto one of the manager's
 * three approved packages. Anything else — an extra unrelated service, a brake job
 * with no general service, spark plugs alone — is CUSTOM_UNBENCHMARKED. It is
 * deliberately not "closest match": inventing a benchmark by summing catalogue times
 * would produce a number nobody agreed to and then rate a technician against it.
 *
 * Pure functions. No database.
 */

export type KpiPackageComponent = 'GENERAL_SERVICE' | 'FRONT_BRAKES' | 'SPARK_PLUGS';

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

/** serviceTypeId -> the component it represents, as configured by an administrator. */
export type PackageComponentMap = ReadonlyMap<string, KpiPackageComponent>;

export interface PackageDetectionResult {
  packageType: KpiPackageType;
  /** Components present, in canonical order. */
  components: KpiPackageComponent[];
  /**
   * Service-type IDs on the job that map to no component. Populated only when the
   * job falls out to CUSTOM_UNBENCHMARKED, so a supervisor can see exactly why.
   */
  unmappedServiceTypeIds: string[];
  reason: string | null;
}

const CANONICAL_ORDER: KpiPackageComponent[] = [
  'GENERAL_SERVICE',
  'FRONT_BRAKES',
  'SPARK_PLUGS',
];

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
 * Classify a job's services into a benchmark package.
 *
 * @param serviceTypeIds every service type on the work order (duplicates fine).
 * @param componentMap   the administrator-configured serviceTypeId -> component map.
 */
export function detectPackage(
  serviceTypeIds: readonly string[],
  componentMap: PackageComponentMap,
): PackageDetectionResult {
  if (serviceTypeIds.length === 0) {
    return {
      packageType: 'CUSTOM_UNBENCHMARKED',
      components: [],
      unmappedServiceTypeIds: [],
      reason: 'The job has no services on it.',
    };
  }

  const present = new Set<KpiPackageComponent>();
  const unmapped: string[] = [];

  for (const id of new Set(serviceTypeIds)) {
    const component = componentMap.get(id);
    if (component) present.add(component);
    else unmapped.push(id);
  }

  const components = CANONICAL_ORDER.filter((c) => present.has(c));

  // Any service outside the mapping means the job is doing more than the benchmark
  // covers, so the benchmark does not describe it.
  if (unmapped.length > 0) {
    return {
      packageType: 'CUSTOM_UNBENCHMARKED',
      components,
      unmappedServiceTypeIds: unmapped,
      reason: `${unmapped.length} service(s) on this job are not part of any benchmark package.`,
    };
  }

  const match = APPROVED_PACKAGES.find(
    (p) =>
      p.components.length === components.length &&
      p.components.every((c) => present.has(c)),
  );

  if (!match) {
    return {
      packageType: 'CUSTOM_UNBENCHMARKED',
      components,
      unmappedServiceTypeIds: [],
      reason:
        components.length === 0
          ? 'None of this job’s services map to a benchmark component.'
          : `${components.join(' + ')} is not one of the three approved packages.`,
    };
  }

  return {
    packageType: match.packageType,
    components,
    unmappedServiceTypeIds: [],
    reason: null,
  };
}

/** Is this package one the manager has set a standard time for? */
export function isBenchmarked(packageType: KpiPackageType): boolean {
  return packageType !== 'CUSTOM_UNBENCHMARKED';
}
