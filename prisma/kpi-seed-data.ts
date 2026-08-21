/**
 * CR-2026-088 — KPI policy, benchmark matrix and package-component mapping.
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
 * Idempotent — safe to re-run on every deploy. Existing policies are never
 * modified, because doing so would silently change what past jobs were measured
 * against.
 */
import type { PrismaClient } from '@prisma/client';

export const KPI_POLICY_NAME = 'Service Centre KPI Standard';
export const KPI_POLICY_VERSION = 1;

type VehicleClass = 'SEDAN_CLASS' | 'SUV_CLASS';
type PackageType =
  | 'GENERAL_SERVICE_ONLY'
  | 'GENERAL_SERVICE_FRONT_BRAKES'
  | 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS';

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

/**
 * Default package-component mapping, by service CODE.
 *
 * This is a starting point the manager is expected to confirm and adjust in the
 * admin screen — it is configuration, not a rule. Detection matches on service-type
 * ID, never on the displayed name, so renaming "Disc Pad Change" in the catalogue
 * cannot silently stop a benchmark from matching.
 *
 * Note there are two plausible front-brake services in the catalogue today
 * (DISC-01 "Disc Pad Change" and BRK-02 "Brake Pad Replacement"). DISC-01 is seeded
 * because the directive named it; if the shop actually books BRK-02 for front
 * brakes, an administrator should move the mapping.
 */
export const KPI_DEFAULT_COMPONENT_MAP: Array<{
  serviceCode: string;
  component: 'GENERAL_SERVICE' | 'FRONT_BRAKES' | 'SPARK_PLUGS';
}> = [
  { serviceCode: 'OIL-01', component: 'GENERAL_SERVICE' },
  { serviceCode: 'DISC-01', component: 'FRONT_BRAKES' },
  { serviceCode: 'SPK-01', component: 'SPARK_PLUGS' },
];

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

  // Map components by looking the codes up — a fresh database may not carry every
  // service, and a missing one must not fail the whole seed.
  let componentsMapped = 0;
  const componentsSkipped: string[] = [];

  for (const m of KPI_DEFAULT_COMPONENT_MAP) {
    const svc = await prisma.serviceType.findUnique({
      where: { code: m.serviceCode },
      select: { id: true },
    });
    if (!svc) {
      componentsSkipped.push(m.serviceCode);
      continue;
    }
    // create-if-missing: never overwrite a mapping an administrator has changed.
    const existing = await prisma.kpiServiceComponent.findUnique({
      where: { serviceTypeId: svc.id },
    });
    if (!existing) {
      await prisma.kpiServiceComponent.create({
        data: { serviceTypeId: svc.id, component: m.component as never },
      });
    }
    componentsMapped++;
  }

  return {
    policyId: policy.id,
    version: policy.version,
    benchmarks: KPI_BENCHMARK_MATRIX.length,
    componentsMapped,
    componentsSkipped,
  };
}
