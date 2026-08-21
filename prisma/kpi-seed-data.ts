/**
 * CR-2026-088 / CR-2026-090 — KPI policy, benchmark matrix and package-component
 * mapping.
 *
 * The benchmark matrix supplied by the service manager, in whole minutes:
 *
 *                 General Service   + Front Brakes   + Spark Plugs
 *   Sedan               90               120              150
 *   SUV                120               150              180
 *
 * SUV is Sedan + 30 at every package, which is what the manager's stated ranges
 * (Sedan 1.5-2.0 h, SUV 2.0-2.5 h) come to: the first value of each range is the
 * standard, and the next 30 minutes are the Meets Target tolerance.
 *
 * Values live here as SEED DATA, not as constants in business logic. The policy is
 * effective-dated and every job snapshots the version it was rated under, so an
 * administrator can retune future standards without rewriting historical results.
 *
 * Idempotent — safe to re-run on every deploy. Existing policies and existing
 * mappings are never modified, because doing so would silently change what past
 * jobs were measured against.
 */
import type { PrismaClient } from '@prisma/client';
import {
  KPI_CONTRIBUTION_SEED,
  PROVISIONAL_ADDITIVE_MINUTES,
} from './kpi-contribution-seed';

export { KPI_CONTRIBUTION_SEED, PROVISIONAL_ADDITIVE_MINUTES };

export const KPI_POLICY_NAME = 'Service Centre KPI Standard';
export const KPI_POLICY_VERSION = 1;

type VehicleClass = 'SEDAN_CLASS' | 'SUV_CLASS';
type PackageType =
  | 'GENERAL_SERVICE_ONLY'
  | 'GENERAL_SERVICE_FRONT_BRAKES'
  | 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS';

type ComponentRole =
  | 'GENERAL_SERVICE_CORE'
  | 'FRONT_BRAKES'
  | 'SPARK_PLUGS'
  | 'INCLUDED_NO_ADDITIONAL_BENCHMARK'
  | 'FORCES_CUSTOM_BENCHMARK';

export const KPI_BENCHMARK_MATRIX: Array<{
  vehicleClass: VehicleClass;
  packageType: PackageType;
  standardMinutes: number;
}> = [
  { vehicleClass: 'SEDAN_CLASS', packageType: 'GENERAL_SERVICE_ONLY', standardMinutes: 90 },
  { vehicleClass: 'SEDAN_CLASS', packageType: 'GENERAL_SERVICE_FRONT_BRAKES', standardMinutes: 120 },
  { vehicleClass: 'SEDAN_CLASS', packageType: 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS', standardMinutes: 150 },
  { vehicleClass: 'SUV_CLASS', packageType: 'GENERAL_SERVICE_ONLY', standardMinutes: 120 },
  { vehicleClass: 'SUV_CLASS', packageType: 'GENERAL_SERVICE_FRONT_BRAKES', standardMinutes: 150 },
  { vehicleClass: 'SUV_CLASS', packageType: 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS', standardMinutes: 180 },
];

// The per-service contribution policy lives in kpi-contribution-seed.ts. The old
// package-or-unmapped list and its "needs a management decision" queue were removed
// with CR-2026-092: every service now carries a policy, so a list of unresolved ones
// would only ever be wrong.

export async function seedKpiFramework(prisma: PrismaClient): Promise<{
  policyId: string;
  version: number;
  benchmarks: number;
  componentsMapped: number;
  componentsSkipped: string[];
}> {
  // Never modify an existing policy version — jobs already point at it, and the
  // whole point of versioning is that history stays reproducible.
  let policy = await prisma.kpiPolicy.findUnique({
    where: { version: KPI_POLICY_VERSION },
  });

  if (!policy) {
    policy = await prisma.kpiPolicy.create({
      data: {
        name: KPI_POLICY_NAME,
        version: KPI_POLICY_VERSION,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        isActive: true,
        meetsToleranceMinutes: 30,
        needsImprovementToleranceMinutes: 60,
        absoluteExcellentMaxMinutes: 120,
        absoluteMeetsTargetMaxMinutes: 150,
        absoluteNeedsImprovementMaxMinutes: 180,
      },
    });
  }

  for (const b of KPI_BENCHMARK_MATRIX) {
    await prisma.kpiBenchmark.upsert({
      where: {
        policyId_vehicleClass_packageType: {
          policyId: policy.id,
          vehicleClass: b.vehicleClass as never,
          packageType: b.packageType as never,
        },
      },
      update: { standardMinutes: b.standardMinutes },
      create: {
        policyId: policy.id,
        vehicleClass: b.vehicleClass as never,
        packageType: b.packageType as never,
        standardMinutes: b.standardMinutes,
      },
    });
  }

  // CR-2026-092 — seed a contribution policy for every service.
  //
  // Looked up by code, because a fresh database may not carry every service and a
  // missing one must not fail the whole seed.
  let componentsMapped = 0;
  let provisionalDurations = 0;
  const componentsSkipped: string[] = [];

  for (const m of KPI_CONTRIBUTION_SEED) {
    const svc = await prisma.serviceType.findUnique({
      where: { code: m.serviceCode },
      select: { id: true, baseDurationMinutes: true },
    });
    if (!svc) {
      componentsSkipped.push(m.serviceCode);
      continue;
    }

    // A service configured to take its minutes from the catalogue, whose catalogue
    // duration is missing or zero, would contribute nothing and quietly understate the
    // standard. Seed a provisional allowance instead and flag it: an obviously
    // stand-in number a manager can see beats an invisible zero.
    const needsProvisional =
      m.durationSource === 'SERVICE_CATALOG_DURATION' &&
      (svc.baseDurationMinutes == null || svc.baseDurationMinutes <= 0);

    // create-if-missing, keyed on the ACTIVE policy: never overwrite one an
    // administrator has changed, and never resurrect one they deactivated.
    const existing = await prisma.kpiServiceComponent.findFirst({
      where: { serviceTypeId: svc.id, isActive: true },
      select: { id: true },
    });
    if (!existing) {
      await prisma.kpiServiceComponent.create({
        data: {
          serviceTypeId: svc.id,
          // The legacy role stays populated so historical reads and the alias grouping
          // keep working; contributionMode is what the calculation actually uses.
          componentRole: (m.componentRole ??
            (m.contributionMode === 'INCLUDED_IN_BASE'
              ? 'INCLUDED_NO_ADDITIONAL_BENCHMARK'
              : m.contributionMode === 'CUSTOM_ONLY'
                ? 'FORCES_CUSTOM_BENCHMARK'
                : 'GENERAL_SERVICE_CORE')) as never,
          contributionMode: m.contributionMode as never,
          durationSource: (needsProvisional
            ? 'FIXED_CONFIGURED_DURATION'
            : m.durationSource) as never,
          allowanceBasis: (m.allowanceBasis ?? 'PER_JOB') as never,
          requiredQualifier: (m.requiredQualifier ?? 'NONE') as never,
          requiresAxleQualifier: m.requiresAxleQualifier ?? false,
          fixedSedanMinutes: needsProvisional
            ? PROVISIONAL_ADDITIVE_MINUTES
            : (m.fixedSedanMinutes ?? null),
          fixedSuvMinutes: m.fixedSuvMinutes ?? null,
          provisionalDuration: needsProvisional || (m.provisionalDuration ?? false),
          isSupersededCode: m.serviceCode === 'DISC-01',
          notes: needsProvisional
            ? `${m.notes} PROVISIONAL: the catalogue carried no usable duration, so a ` +
              `${PROVISIONAL_ADDITIVE_MINUTES}-minute allowance was seeded for management to confirm.`
            : m.notes,
        },
      });
      if (needsProvisional) provisionalDurations++;
    }
    componentsMapped++;
  }

  return {
    policyId: policy.id,
    version: policy.version,
    benchmarks: KPI_BENCHMARK_MATRIX.length,
    componentsMapped,
    componentsSkipped,
    provisionalDurations,
  };
}
