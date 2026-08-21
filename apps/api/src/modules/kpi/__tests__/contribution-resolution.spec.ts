import { describe, it, expect } from 'vitest';
import {
  calculateStandard,
  isCountableLine,
  type ContributionPolicy,
  type ContributionPolicyMap,
  type WorkOrderLine,
  type ResolveOptions,
} from '../engine/contribution-resolution';

/**
 * CR-2026-092 — how each service contributes to a job's standard.
 *
 * The rule that runs through all of it: **a manager package requires a General
 * Service**. Front-brake work on its own is a brake repair measured against the brake
 * catalogue time, not "General Service + Front Brakes" — giving it the package
 * allowance would hand a technician ninety minutes of general-service time nobody
 * asked them to spend.
 *
 * The manager's matrix, for reference:
 *
 *                  General   +Front Brakes   +Spark Plugs
 *   Sedan             90          120            150
 *   SUV              120          150            180
 */

const OIL = 'st-oil';
const BRK = 'st-brake'; // conditional: axle + work type
const SPK = 'st-plugs';
const FUEL = 'st-fuelfilter'; // additive
const TIRE = 'st-tire'; // conditional: tyre operation
const EST = 'st-estimate';
const SLA = 'st-quote'; // separate-SLA activity
const BESPOKE = 'st-bespoke';
const UNMAPPED = 'st-unmapped';

const policy = (over: Partial<ContributionPolicy>): ContributionPolicy => ({
  contributionMode: 'CUSTOM_ONLY',
  componentRole: null,
  durationSource: 'NO_DURATION',
  fixedSedanMinutes: null,
  fixedSuvMinutes: null,
  allowanceBasis: 'PER_JOB',
  requiredQualifier: 'NONE',
  provisionalDuration: false,
  ...over,
});

const policies: ContributionPolicyMap = new Map([
  [
    OIL,
    policy({
      contributionMode: 'PACKAGE_COMPONENT',
      componentRole: 'GENERAL_SERVICE_CORE',
      durationSource: 'MANAGER_PACKAGE',
    }),
  ],
  [
    SPK,
    policy({
      contributionMode: 'PACKAGE_COMPONENT',
      componentRole: 'SPARK_PLUGS',
      durationSource: 'MANAGER_PACKAGE',
    }),
  ],
  [
    BRK,
    policy({
      contributionMode: 'CONDITIONAL',
      componentRole: 'FRONT_BRAKES',
      requiredQualifier: 'BRAKE',
      durationSource: 'SERVICE_CATALOG_DURATION',
    }),
  ],
  [
    TIRE,
    policy({
      contributionMode: 'CONDITIONAL',
      requiredQualifier: 'TIRE_OPERATION',
      durationSource: 'SERVICE_CATALOG_DURATION',
    }),
  ],
  [
    FUEL,
    policy({
      contributionMode: 'ADDITIVE_STANDARD',
      durationSource: 'SERVICE_CATALOG_DURATION',
    }),
  ],
  [
    EST,
    policy({
      contributionMode: 'ADDITIVE_STANDARD',
      durationSource: 'SERVICE_CATALOG_DURATION',
    }),
  ],
  [SLA, policy({ contributionMode: 'SEPARATE_SLA', durationSource: 'NO_DURATION' })],
  [BESPOKE, policy({ contributionMode: 'CUSTOM_ONLY' })],
]);

const MATRIX: Record<string, Record<string, number>> = {
  SEDAN_CLASS: {
    GENERAL_SERVICE_ONLY: 90,
    GENERAL_SERVICE_FRONT_BRAKES: 120,
    GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS: 150,
  },
  SUV_CLASS: {
    GENERAL_SERVICE_ONLY: 120,
    GENERAL_SERVICE_FRONT_BRAKES: 150,
    GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS: 180,
  },
};

const opts = (vehicleClass: 'SEDAN_CLASS' | 'SUV_CLASS' | null = 'SEDAN_CLASS'): ResolveOptions => ({
  vehicleClass,
  packageStandard: (cls, pkg) => MATRIX[cls]?.[pkg] ?? null,
});

let seq = 0;
const line = (
  serviceTypeId: string,
  over: Partial<WorkOrderLine> = {},
): WorkOrderLine => ({
  id: `line-${++seq}`,
  serviceTypeId,
  serviceCode: serviceTypeId,
  serviceName: serviceTypeId,
  catalogueMinutes: 30,
  status: 'PLANNED',
  ...over,
});

const oil = () => line(OIL, { serviceCode: 'OIL-01', catalogueMinutes: 30 });
const fuel = () => line(FUEL, { serviceCode: 'FUEL-FLT-01', catalogueMinutes: 30 });
const brake = (over: Partial<WorkOrderLine>) =>
  line(BRK, { serviceCode: 'BRK-02', catalogueMinutes: 90, ...over });
const tire = (over: Partial<WorkOrderLine>) =>
  line(TIRE, { serviceCode: 'TIR-01', catalogueMinutes: 25, ...over });

// ---------------------------------------------------------------------------
// Fuel filter — additive
// ---------------------------------------------------------------------------
describe('FUEL-FLT-01 — additive standard', () => {
  it('adds its catalogue duration to the package once', () => {
    const c = calculateStandard([oil(), fuel()], policies, opts());
    expect(c.basePackageMinutes).toBe(90);
    expect(c.additiveMinutes).toBe(30);
    expect(c.finalStandardMinutes).toBe(120);
    expect(c.benchmarkSource).toBe('MANAGER_PACKAGE_PLUS_ADDITIVES');
  });

  it('performed alone, gets a catalogue-based standard rather than a package', () => {
    // The job is still perfectly rateable. What it must not get is 90 minutes of
    // general-service allowance for work that was not a general service.
    const c = calculateStandard([fuel()], policies, opts());
    expect(c.finalStandardMinutes).toBe(30);
    expect(c.benchmarkSource).toBe('CATALOG_COMPOSITE');
    expect(c.basePackageMinutes).toBeNull();
  });

  it('is not multiplied by quantity on a PER_JOB allowance', () => {
    const c = calculateStandard(
      [oil(), fuel(), fuel()],
      policies,
      opts(),
    );
    expect(c.additiveMinutes).toBe(30);
    expect(c.finalStandardMinutes).toBe(120);
  });

  it('ignores unitQuantity unless the basis is PER_UNIT', () => {
    const c = calculateStandard(
      [oil(), line(FUEL, { serviceCode: 'FUEL-FLT-01', catalogueMinutes: 30, unitQuantity: 4 })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(120);
  });

  it('multiplies only where the policy says PER_UNIT', () => {
    const perUnit: ContributionPolicyMap = new Map([
      ...policies,
      [
        FUEL,
        policy({
          contributionMode: 'ADDITIVE_STANDARD',
          durationSource: 'SERVICE_CATALOG_DURATION',
          allowanceBasis: 'PER_UNIT',
        }),
      ],
    ]);
    const c = calculateStandard(
      [oil(), line(FUEL, { catalogueMinutes: 10, unitQuantity: 4 })],
      perUnit,
      opts(),
    );
    expect(c.additiveMinutes).toBe(40);
  });

  it('uses the same additive minutes for Sedan and SUV', () => {
    // Only the manager PACKAGE base differs by class. Inventing a class split for
    // additive work would rate an SUV technician against a number nobody approved.
    const sedan = calculateStandard([oil(), fuel()], policies, opts('SEDAN_CLASS'));
    const suv = calculateStandard([oil(), fuel()], policies, opts('SUV_CLASS'));
    expect(sedan.additiveMinutes).toBe(suv.additiveMinutes);
    expect(sedan.finalStandardMinutes).toBe(120); // 90 + 30
    expect(suv.finalStandardMinutes).toBe(150); // 120 + 30
  });
});

// ---------------------------------------------------------------------------
// Brakes — conditional
// ---------------------------------------------------------------------------
describe('brakes — conditional on axle and work type', () => {
  it('front pads WITH a general service select the Front Brakes package', () => {
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'FRONT', brakeWorkType: 'PADS' })],
      policies,
      opts(),
    );
    expect(c.packageType).toBe('GENERAL_SERVICE_FRONT_BRAKES');
    expect(c.finalStandardMinutes).toBe(120);
  });

  it('front pads with a general service do NOT also add the catalogue duration', () => {
    // The package already contains the front-brake allowance. Adding the 90-minute
    // catalogue time on top would pay for the same work twice.
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'FRONT', brakeWorkType: 'PADS' })],
      policies,
      opts(),
    );
    expect(c.additiveMinutes).toBe(0);
    expect(c.finalStandardMinutes).toBe(120);
    expect(c.benchmarkSource).toBe('MANAGER_PACKAGE');
  });

  it('SUV front pads with a general service use the SUV package figure', () => {
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'FRONT', brakeWorkType: 'PADS' })],
      policies,
      opts('SUV_CLASS'),
    );
    expect(c.finalStandardMinutes).toBe(150);
  });

  it('front pads WITHOUT a general service use their catalogue duration', () => {
    const c = calculateStandard(
      [brake({ axlePosition: 'FRONT', brakeWorkType: 'PADS' })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(90);
    expect(c.benchmarkSource).toBe('CATALOG_COMPOSITE');
    expect(c.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(c.reason).toMatch(/no general service/i);
  });

  it('rear pads add time to the general service package', () => {
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'REAR', brakeWorkType: 'PADS' })],
      policies,
      opts(),
    );
    expect(c.packageType).toBe('GENERAL_SERVICE_ONLY');
    expect(c.additiveMinutes).toBe(90);
    expect(c.finalStandardMinutes).toBe(180);
    expect(c.benchmarkSource).toBe('MANAGER_PACKAGE_PLUS_ADDITIVES');
  });

  it('brake shoes do NOT trigger the Front Brakes package', () => {
    // Shoes are drum work. Family membership is not a classification.
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'REAR', brakeWorkType: 'SHOES' })],
      policies,
      opts(),
    );
    expect(c.components).not.toContain('FRONT_BRAKES');
    expect(c.packageType).toBe('GENERAL_SERVICE_ONLY');
    expect(c.additiveMinutes).toBe(90);
  });

  it('front shoes are additive too, not the Front Brakes component', () => {
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'FRONT', brakeWorkType: 'SHOES' })],
      policies,
      opts(),
    );
    expect(c.components).not.toContain('FRONT_BRAKES');
    expect(c.additiveMinutes).toBe(90);
  });

  it('selecting both axles creates TWO resolved contributions', () => {
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'FRONT_AND_REAR', brakeWorkType: 'PADS' })],
      policies,
      opts(),
    );
    const brakeContribs = c.contributions.filter((x) => x.serviceCode === 'BRK-02');
    expect(brakeContribs).toHaveLength(2);
    expect(brakeContribs.map((x) => x.qualifierLabel)).toEqual([
      'Front · Pads',
      'Rear · Pads',
    ]);
    // Front is the package component; rear is genuine extra work.
    expect(c.packageType).toBe('GENERAL_SERVICE_FRONT_BRAKES');
    expect(c.additiveMinutes).toBe(90);
    expect(c.finalStandardMinutes).toBe(210);
  });

  it('rotor, fluid and other brake work are additive', () => {
    for (const workType of ['ROTOR_OR_DISC', 'FLUID_OR_BLEED', 'OTHER'] as const) {
      const c = calculateStandard(
        [oil(), brake({ axlePosition: 'FRONT', brakeWorkType: workType })],
        policies,
        opts(),
      );
      expect(c.components).not.toContain('FRONT_BRAKES');
      expect(c.additiveMinutes).toBe(90);
    }
  });

  it('brake inspection inside a general service adds nothing', () => {
    const c = calculateStandard(
      [oil(), brake({ serviceCode: 'BRK-01', catalogueMinutes: 30, brakeWorkType: 'INSPECTION_ONLY' })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(90);
    expect(c.contributions.find((x) => x.serviceCode === 'BRK-01')?.mode).toBe(
      'INCLUDED_IN_BASE',
    );
  });

  it('a standalone brake inspection uses its catalogue standard', () => {
    const c = calculateStandard(
      [brake({ serviceCode: 'BRK-01', catalogueMinutes: 30, brakeWorkType: 'INSPECTION_ONLY' })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(30);
    expect(c.benchmarkSource).toBe('CATALOG_COMPOSITE');
  });

  it('a missing axle is reported as an actionable qualifier problem', () => {
    const c = calculateStandard(
      [oil(), brake({ brakeWorkType: 'PADS' })],
      policies,
      opts(),
    );
    expect(c.requiresBenchmarkReview).toBe(true);
    expect(c.missingQualifiers).toHaveLength(1);
    expect(c.missingQualifiers[0].message).toMatch(/which axle/i);
    expect(c.finalStandardMinutes).toBeNull();
  });

  it('a missing brake work type is reported too', () => {
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'FRONT' })],
      policies,
      opts(),
    );
    expect(c.missingQualifiers[0].message).toMatch(/work type/i);
  });

  it('inspection needs no axle', () => {
    const c = calculateStandard(
      [oil(), brake({ brakeWorkType: 'INSPECTION_ONLY' })],
      policies,
      opts(),
    );
    expect(c.missingQualifiers).toHaveLength(0);
  });
});

describe('brake aliases', () => {
  const withAliases: ContributionPolicyMap = new Map([
    ...policies,
    [
      'st-disc',
      policy({
        contributionMode: 'CONDITIONAL',
        componentRole: 'FRONT_BRAKES',
        requiredQualifier: 'BRAKE',
        durationSource: 'SERVICE_CATALOG_DURATION',
      }),
    ],
  ]);

  it('two alias codes satisfy the Front Brakes component only ONCE', () => {
    const c = calculateStandard(
      [
        oil(),
        brake({ axlePosition: 'FRONT', brakeWorkType: 'PADS' }),
        line('st-disc', {
          serviceCode: 'DISC-01',
          catalogueMinutes: 60,
          axlePosition: 'FRONT',
          brakeWorkType: 'PADS',
        }),
      ],
      withAliases,
      opts(),
    );

    expect(c.packageType).toBe('GENERAL_SERVICE_FRONT_BRAKES');
    expect(c.finalStandardMinutes).toBe(120);
    // Three separate time allowances would be the failure. There is one.
    expect(c.additiveMinutes).toBe(0);
    expect(c.contributions.filter((x) => x.suppressedAsDuplicate)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tyres — conditional
// ---------------------------------------------------------------------------
describe('tyres — conditional on operation', () => {
  it('a pressure check inside a general service adds zero minutes', () => {
    const c = calculateStandard(
      [oil(), tire({ tireOperation: 'PRESSURE_OR_TREAD_CHECK' })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(90);
    expect(c.additiveMinutes).toBe(0);
    expect(c.contributions.find((x) => x.serviceCode === 'TIR-01')?.mode).toBe(
      'INCLUDED_IN_BASE',
    );
  });

  it('a standalone pressure check uses its catalogue standard', () => {
    const c = calculateStandard(
      [tire({ tireOperation: 'PRESSURE_OR_TREAD_CHECK' })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(25);
    expect(c.benchmarkSource).toBe('CATALOG_COMPOSITE');
  });

  it('rotation adds its catalogue duration', () => {
    const c = calculateStandard(
      [oil(), tire({ tireOperation: 'ROTATION' })],
      policies,
      opts(),
    );
    expect(c.additiveMinutes).toBe(25);
    expect(c.finalStandardMinutes).toBe(115);
  });

  it('balance, alignment, puncture repair and replacement are all additive', () => {
    for (const op of [
      'BALANCE',
      'ALIGNMENT',
      'PUNCTURE_REPAIR',
      'REPLACEMENT',
      'OTHER_PHYSICAL_WORK',
    ] as const) {
      const c = calculateStandard([oil(), tire({ tireOperation: op })], policies, opts());
      expect(c.additiveMinutes).toBe(25);
    }
  });

  it('tyre quantity does not multiply a per-job allowance', () => {
    const c = calculateStandard(
      [oil(), tire({ tireOperation: 'ROTATION', unitQuantity: 4 })],
      policies,
      opts(),
    );
    expect(c.additiveMinutes).toBe(25);
  });

  it('a missing tyre operation is reported as actionable', () => {
    const c = calculateStandard([oil(), tire({})], policies, opts());
    expect(c.requiresBenchmarkReview).toBe(true);
    expect(c.missingQualifiers[0].message).toMatch(/tyre operation/i);
  });

  it('a declined tyre replacement does not change the benchmark', () => {
    // A recommendation the customer turned down is not work the technician was asked
    // to do, and must not extend what they are measured against.
    const c = calculateStandard(
      [oil(), tire({ tireOperation: 'REPLACEMENT', status: 'DECLINED' })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(90);
    expect(c.additiveMinutes).toBe(0);
  });

  it('a tyre replacement still awaiting approval does not count either', () => {
    const c = calculateStandard(
      [oil(), tire({ tireOperation: 'REPLACEMENT', status: 'PENDING_APPROVAL' })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(90);
  });

  it('counts it once the customer approves and it is a real order line', () => {
    const c = calculateStandard(
      [oil(), tire({ tireOperation: 'REPLACEMENT', status: 'APPROVED' })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(115);
  });
});

// ---------------------------------------------------------------------------
// Separate SLA
// ---------------------------------------------------------------------------
describe('separate-SLA activity', () => {
  it('does not affect technician KPI time', () => {
    const c = calculateStandard([oil(), line(SLA, { serviceCode: 'QUOTE-01' })], policies, opts());
    expect(c.finalStandardMinutes).toBe(90);
    expect(c.additiveMinutes).toBe(0);
  });

  it('does not make the job unrateable', () => {
    const c = calculateStandard([oil(), line(SLA)], policies, opts());
    expect(c.packageType).toBe('GENERAL_SERVICE_ONLY');
    expect(c.requiresBenchmarkReview).toBe(false);
  });

  it('appears in the breakdown so the exclusion is visible', () => {
    const c = calculateStandard([oil(), line(SLA)], policies, opts());
    const sla = c.contributions.find((x) => x.mode === 'SEPARATE_SLA');
    expect(sla).toBeDefined();
    expect(sla!.minutes).toBe(0);
  });

  it('a job of nothing but advisor activity is not technician-rated', () => {
    const c = calculateStandard([line(SLA)], policies, opts());
    expect(c.benchmarkSource).toBe('NOT_TECHNICIAN_RATED');
    expect(c.finalStandardMinutes).toBeNull();
  });

  it('a technician diagnostic mapped as additive DOES extend the standard', () => {
    // EST-01 proved to be technician assessment work, not quotation preparation.
    const c = calculateStandard(
      [oil(), line(EST, { serviceCode: 'EST-01', catalogueMinutes: 30 })],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBe(120);
    expect(c.contributions.find((x) => x.serviceCode === 'EST-01')?.mode).toBe(
      'ADDITIVE_STANDARD',
    );
  });
});

// ---------------------------------------------------------------------------
// General rules
// ---------------------------------------------------------------------------
describe('line eligibility', () => {
  it('excludes cancelled, declined, removed and pending lines', () => {
    for (const s of ['CANCELLED', 'DECLINED', 'REMOVED', 'VOID', 'PENDING_APPROVAL', 'DEFERRED']) {
      expect(isCountableLine(s)).toBe(false);
    }
  });

  it('counts planned, approved, in-progress and completed lines', () => {
    for (const s of ['PLANNED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', null, undefined]) {
      expect(isCountableLine(s)).toBe(true);
    }
  });

  it('a job whose every line was cancelled is not rateable', () => {
    const c = calculateStandard(
      [{ ...oil(), status: 'CANCELLED' }],
      policies,
      opts(),
    );
    expect(c.finalStandardMinutes).toBeNull();
    expect(c.reason).toMatch(/cancelled|declined/i);
  });
});

describe('unmapped and bespoke work', () => {
  it('an unmapped service holds the job for benchmark review', () => {
    const c = calculateStandard([oil(), line(UNMAPPED)], policies, opts());
    expect(c.requiresBenchmarkReview).toBe(true);
    expect(c.unmappedServiceTypeIds).toEqual([UNMAPPED]);
    expect(c.finalStandardMinutes).toBeNull();
  });

  it('CUSTOM_ONLY work leaves the job unrated, and says why', () => {
    const c = calculateStandard([oil(), line(BESPOKE)], policies, opts());
    expect(c.hasCustomOnlyWork).toBe(true);
    expect(c.benchmarkSource).toBe('NOT_TECHNICIAN_RATED');
    expect(c.reason).toMatch(/bespoke/i);
  });
});

describe('the breakdown is complete enough to defend', () => {
  it('shows base, each additive, included and separate-SLA lines, and the total', () => {
    const c = calculateStandard(
      [oil(), fuel(), tire({ tireOperation: 'PRESSURE_OR_TREAD_CHECK' }), line(SLA)],
      policies,
      opts(),
    );

    expect(c.basePackageMinutes).toBe(90);
    expect(c.additiveMinutes).toBe(30);
    expect(c.finalStandardMinutes).toBe(120);
    expect(c.benchmarkSource).toBe('MANAGER_PACKAGE_PLUS_ADDITIVES');

    const modes = c.contributions.map((x) => x.mode);
    expect(modes).toContain('PACKAGE_COMPONENT');
    expect(modes).toContain('ADDITIVE_STANDARD');
    expect(modes).toContain('INCLUDED_IN_BASE');
    expect(modes).toContain('SEPARATE_SLA');
  });

  it('carries the resolved qualifier labels for display', () => {
    const c = calculateStandard(
      [oil(), brake({ axlePosition: 'REAR', brakeWorkType: 'SHOES' }), tire({ tireOperation: 'ROTATION' })],
      policies,
      opts(),
    );
    const labels = c.contributions.map((x) => x.qualifierLabel).filter(Boolean);
    expect(labels).toContain('Rear · Shoes');
    expect(labels).toContain('Tyre · Rotation');
  });

  it('flags a provisional duration so it is replaced deliberately', () => {
    const provisional: ContributionPolicyMap = new Map([
      ...policies,
      [
        FUEL,
        policy({
          contributionMode: 'ADDITIVE_STANDARD',
          durationSource: 'FIXED_CONFIGURED_DURATION',
          fixedSedanMinutes: 30,
          provisionalDuration: true,
        }),
      ],
    ]);
    const c = calculateStandard([oil(), fuel()], provisional, opts());
    expect(c.provisionalDurationsUsed).toBe(true);
    expect(c.finalStandardMinutes).toBe(120);
  });

  it('without a confirmed vehicle class there is no package base', () => {
    const c = calculateStandard([oil(), fuel()], policies, opts(null));
    expect(c.benchmarkSource).toBe('CATALOG_COMPOSITE');
    expect(c.basePackageMinutes).toBeNull();
  });
});
