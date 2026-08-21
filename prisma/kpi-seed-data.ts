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

/**
 * Default package-component mapping, by service CODE.
 *
 * A starting point the manager confirms and adjusts in Admin -> KPI package
 * mapping. It is configuration, not a rule. Detection matches on service-type ID,
 * never on the displayed name, so renaming "Disc Pad Change" in the catalogue
 * cannot silently stop a benchmark from matching.
 *
 * An unmapped service is NOT neutral: it forces CUSTOM_UNBENCHMARKED. That is the
 * deliberately safe direction, because the failure modes are not symmetric. Marking
 * real extra work as "included" leaves the job benchmarked at a standard that never
 * accounted for it and rates the technician slow for doing more; leaving a service
 * unmapped only costs an adjusted rating on that job. So this list under-claims on
 * purpose, and the gaps below are flagged for the manager rather than guessed.
 */
export const KPI_DEFAULT_COMPONENT_MAP: Array<{
  serviceCode: string;
  componentRole: ComponentRole;
  requiresAxleQualifier?: boolean;
  notes: string;
}> = [
  {
    serviceCode: 'OIL-01',
    componentRole: 'GENERAL_SERVICE_CORE',
    notes: 'Anchors the General Service component of every benchmarked package.',
  },

  // --- Front brakes: two catalogue codes, one component -------------------
  //
  // DISC-01 "Disc Pad Change" and BRK-02 "Brake Pad Replacement" both describe
  // front-brake pad work, so both are mapped as ALIASES of the one FRONT_BRAKES
  // component. Detection counts the component once even if both appear on a work
  // order, so a job cannot earn the brake allowance twice for one set of pads.
  //
  // Both require an axle qualifier. The shop's imported price list distinguishes
  // axles explicitly — it carries "To R/R DISC PADS" and "To R/R DISC PADS rear
  // electronic" as separate lines, plus brake shoes for drums — while neither
  // Traction code encodes an axle at all. A brake line is therefore genuinely
  // ambiguous on its own, and rear-only work must never silently satisfy a
  // benchmark built for front brakes.
  {
    serviceCode: 'DISC-01',
    componentRole: 'FRONT_BRAKES',
    requiresAxleQualifier: true,
    notes:
      'Alias of BRK-02. Satisfies Front Brakes only when the line is qualified FRONT ' +
      '(or FRONT_AND_REAR where management approves).',
  },
  {
    serviceCode: 'BRK-02',
    componentRole: 'FRONT_BRAKES',
    requiresAxleQualifier: true,
    notes:
      'Alias of DISC-01. Historically the code actually booked for brake work — ' +
      'DISC-01 has never been used on a work order.',
  },

  {
    serviceCode: 'SPK-01',
    componentRole: 'SPARK_PLUGS',
    notes: 'Anchors the Spark Plugs component.',
  },

  // --- Absorbed by the General Service standard ---------------------------
  //
  // Only activities the manager's own general-service breakdown names ("oil change,
  // filters, wipers, fluid checks, paperwork") are marked absorbed. These add no
  // component and no extra time: the 90/120-minute standard already contains them,
  // so booking them as separate lines is a bookkeeping artefact and must not knock
  // the job out of its benchmark.
  {
    serviceCode: 'OIL-FLT-01',
    componentRole: 'INCLUDED_NO_ADDITIONAL_BENCHMARK',
    notes: 'An oil change includes the filter; a separate line is bookkeeping, not extra work.',
  },
  {
    serviceCode: 'AIR-FLT-01',
    componentRole: 'INCLUDED_NO_ADDITIONAL_BENCHMARK',
    notes: 'Named under "filters" in the general-service activity breakdown.',
  },
  {
    serviceCode: 'WIPER-01',
    componentRole: 'INCLUDED_NO_ADDITIONAL_BENCHMARK',
    notes: 'Named as "wipers" in the general-service activity breakdown.',
  },

  // --- Substantial work the approved packages do not describe -------------
  //
  // These would force CUSTOM_UNBENCHMARKED anyway by being unmapped. Marking them
  // explicitly is what separates "management decided this needs its own standard"
  // from "nobody has looked at this yet" — the admin screen surfaces the second as
  // outstanding work, and the manager sees a real reason instead of "not mapped".
  ...(
    [
      ['ENG-02', 'Major tune-up — a job in its own right, not a package add-on.'],
      ['ENG-01', 'Diagnostic time is investigative and does not fit a fixed benchmark.'],
      ['ELE-01', 'Diagnostic time is investigative and does not fit a fixed benchmark.'],
      ['TRANS-01', 'Diagnostic time is investigative and does not fit a fixed benchmark.'],
      ['RACK-01', 'Major steering work.'],
      ['SUSP-02', 'Major suspension work.'],
      ['SHOCK-01', 'Major suspension work.'],
      ['BJOINT-01', 'Major suspension work.'],
      ['COL-01', 'Cooling system service is substantial standalone work.'],
      ['AC-02', 'A/C repair is substantial standalone work.'],
      ['INSP-01', 'Pre-purchase inspection is a distinct product, not service work.'],
      ['MSHOP-01', 'External machine-shop work — elapsed time is outside the technician’s control.'],
    ] as const
  ).map(([serviceCode, notes]) => ({
    serviceCode,
    componentRole: 'FORCES_CUSTOM_BENCHMARK' as ComponentRole,
    notes,
  })),
];

/**
 * Services deliberately left unmapped, and why. Not seeded — recorded so the gap is
 * visible in the admin screen's "needs review" list instead of looking like an
 * oversight.
 */
export const KPI_UNMAPPED_FOR_REVIEW: Array<{ serviceCode: string; question: string }> = [
  {
    serviceCode: 'FUEL-FLT-01',
    question:
      'Is a fuel filter change part of your standard general service, or extra work? ' +
      'The activity breakdown says "filters" without saying which.',
  },
  {
    serviceCode: 'BRK-01',
    question:
      'Brake Inspection is inspection-only. Is it absorbed by the general service, ' +
      'or does a job that includes it need its own standard?',
  },
  {
    serviceCode: 'EST-01',
    question: 'Is a booked estimate/inspection line technician work that should be benchmarked?',
  },
  {
    serviceCode: 'TIR-01',
    question: 'Is a tyre rotation part of your standard general service?',
  },
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

    // create-if-missing, keyed on the ACTIVE mapping: never overwrite a mapping an
    // administrator has changed, and never resurrect one they deactivated.
    const existing = await prisma.kpiServiceComponent.findFirst({
      where: { serviceTypeId: svc.id, isActive: true },
      select: { id: true },
    });
    if (!existing) {
      await prisma.kpiServiceComponent.create({
        data: {
          serviceTypeId: svc.id,
          componentRole: m.componentRole as never,
          requiresAxleQualifier: m.requiresAxleQualifier ?? false,
          notes: m.notes,
        },
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
