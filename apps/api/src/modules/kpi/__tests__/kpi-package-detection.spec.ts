import { describe, it, expect } from 'vitest';
import {
  detectPackage,
  isBenchmarked,
  type PackageComponentMap,
  type ServiceLine,
} from '../engine/package-detection';

/**
 * CR-2026-088 / CR-2026-090 — benchmark package detection.
 *
 * Split out of kpi-engine.spec.ts when v2 added component roles, aliases and the
 * axle qualifier: the detection rules now carry enough weight to be read on their
 * own, and the three new behaviours are exactly the ones a future change is most
 * likely to break quietly.
 */

const OIL = 'svc-oil';
const SERVICE = 'svc-service';
const DISC = 'svc-discpad'; // DISC-01 in the catalogue
const BRK = 'svc-brakepad'; // BRK-02 — the other front-brake code
const PLUGS = 'svc-plugs';
const OILFILTER = 'svc-oilfilter';
const TUNEUP = 'svc-tuneup';
const AIRCON = 'svc-aircon'; // deliberately unmapped

const map: PackageComponentMap = new Map([
  [OIL, { componentRole: 'GENERAL_SERVICE_CORE', requiresAxleQualifier: false }],
  [SERVICE, { componentRole: 'GENERAL_SERVICE_CORE', requiresAxleQualifier: false }],
  // The two front-brake aliases. Both need an axle, because neither code says which.
  [DISC, { componentRole: 'FRONT_BRAKES', requiresAxleQualifier: true }],
  [BRK, { componentRole: 'FRONT_BRAKES', requiresAxleQualifier: true }],
  [PLUGS, { componentRole: 'SPARK_PLUGS', requiresAxleQualifier: false }],
  [
    OILFILTER,
    { componentRole: 'INCLUDED_NO_ADDITIONAL_BENCHMARK', requiresAxleQualifier: false },
  ],
  [TUNEUP, { componentRole: 'FORCES_CUSTOM_BENCHMARK', requiresAxleQualifier: false }],
]);

/** Terse line builder — most tests care about the service, not the axle. */
const line = (serviceTypeId: string, axlePosition?: ServiceLine['axlePosition']): ServiceLine => ({
  serviceTypeId,
  axlePosition,
});

const front = (id: string) => line(id, 'FRONT');

describe('package detection — the three approved packages', () => {
  it('detects all three', () => {
    expect(detectPackage([line(OIL)], map).packageType).toBe('GENERAL_SERVICE_ONLY');
    expect(detectPackage([line(OIL), front(DISC)], map).packageType).toBe(
      'GENERAL_SERVICE_FRONT_BRAKES',
    );
    expect(detectPackage([line(OIL), front(DISC), line(PLUGS)], map).packageType).toBe(
      'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS',
    );
  });

  it('is order- and duplicate-insensitive', () => {
    const r = detectPackage([line(PLUGS), front(DISC), line(OIL), line(OIL)], map);
    expect(r.packageType).toBe('GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS');
  });

  it('treats two services mapping to the same component as one component', () => {
    expect(detectPackage([line(OIL), line(SERVICE)], map).packageType).toBe(
      'GENERAL_SERVICE_ONLY',
    );
  });

  it('falls out to custom for a combination the manager did not approve', () => {
    // Brakes without a general service is real work, but it has no standard.
    const r = detectPackage([front(DISC)], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.reason).toMatch(/not one of the three approved packages/i);
  });

  it('never matches on service names, only configured ids', () => {
    const r = detectPackage([line(OIL), front(DISC)], new Map());
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
  });

  it('handles a job with no services', () => {
    const r = detectPackage([], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.reason).toMatch(/no services/i);
  });

  it('knows which packages carry a standard', () => {
    expect(isBenchmarked('GENERAL_SERVICE_ONLY')).toBe(true);
    expect(isBenchmarked('CUSTOM_UNBENCHMARKED')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CR-2026-090 — aliases
// ---------------------------------------------------------------------------
describe('front-brake aliases (DISC-01 / BRK-02)', () => {
  it('either code alone satisfies the Front Brakes component', () => {
    expect(detectPackage([line(OIL), front(DISC)], map).packageType).toBe(
      'GENERAL_SERVICE_FRONT_BRAKES',
    );
    expect(detectPackage([line(OIL), front(BRK)], map).packageType).toBe(
      'GENERAL_SERVICE_FRONT_BRAKES',
    );
  });

  it('both codes on one order still count as ONE component, not two', () => {
    // The failure this guards against is a job earning the brake allowance twice for
    // one set of pads, which would show up as a technician beating the standard.
    const r = detectPackage([line(OIL), front(DISC), front(BRK)], map);
    expect(r.packageType).toBe('GENERAL_SERVICE_FRONT_BRAKES');
    expect(r.components).toEqual(['GENERAL_SERVICE', 'FRONT_BRAKES']);
    expect(r.components.filter((c) => c === 'FRONT_BRAKES')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CR-2026-090 — axle qualifier
// ---------------------------------------------------------------------------
describe('axle qualifier', () => {
  it('a FRONT brake line satisfies the component', () => {
    expect(detectPackage([line(OIL), line(DISC, 'FRONT')], map).packageType).toBe(
      'GENERAL_SERVICE_FRONT_BRAKES',
    );
  });

  it('a REAR-only brake line does NOT satisfy the front-brake standard', () => {
    const r = detectPackage([line(OIL), line(DISC, 'REAR')], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.disqualifiedByAxleServiceTypeIds).toEqual([DISC]);
    expect(r.reason).toMatch(/front/i);
  });

  it('an unqualified brake line blocks benchmarking and says the axle is the reason', () => {
    const r = detectPackage([line(OIL), line(DISC)], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.awaitingAxleQualifierServiceTypeIds).toEqual([DISC]);
    expect(r.resolvableByAxleQualifier).toBe(true);
    expect(r.reason).toMatch(/no axle recorded/i);
  });

  it('FRONT_AND_REAR does not qualify unless management approved it', () => {
    const r = detectPackage([line(OIL), line(DISC, 'FRONT_AND_REAR')], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.disqualifiedByAxleServiceTypeIds).toEqual([DISC]);
  });

  it('FRONT_AND_REAR qualifies once management approves it', () => {
    const r = detectPackage([line(OIL), line(DISC, 'FRONT_AND_REAR')], map, {
      frontAndRearSatisfiesFrontBrakes: true,
    });
    expect(r.packageType).toBe('GENERAL_SERVICE_FRONT_BRAKES');
  });

  it('NOT_APPLICABLE on a line whose whole question is the axle does not qualify', () => {
    const r = detectPackage([line(OIL), line(DISC, 'NOT_APPLICABLE')], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
  });

  it('does not require an axle on services that are not axle-specific', () => {
    expect(detectPackage([line(OIL), line(PLUGS)], map).components).toContain('SPARK_PLUGS');
  });

  it('a duplicate line without an axle does not block one that has it', () => {
    const r = detectPackage([line(OIL), front(DISC), line(DISC)], map);
    expect(r.packageType).toBe('GENERAL_SERVICE_FRONT_BRAKES');
  });

  it('resolvableByAxleQualifier is false when something else is also wrong', () => {
    // Telling staff "record the axle" when it would not help is worse than useless.
    const r = detectPackage([line(OIL), line(DISC), line(AIRCON)], map);
    expect(r.resolvableByAxleQualifier).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CR-2026-090 — absorbed work and work that forces a custom benchmark
// ---------------------------------------------------------------------------
describe('component roles beyond the benchmark trio', () => {
  it('absorbed work does not knock a job out of its package', () => {
    // An oil filter booked as its own line is bookkeeping; the general-service
    // standard already contains it.
    const r = detectPackage([line(OIL), line(OILFILTER)], map);
    expect(r.packageType).toBe('GENERAL_SERVICE_ONLY');
    expect(r.absorbedServiceTypeIds).toEqual([OILFILTER]);
  });

  it('absorbed work adds no component of its own', () => {
    const r = detectPackage([line(OIL), line(OILFILTER)], map);
    expect(r.components).toEqual(['GENERAL_SERVICE']);
  });

  it('absorbed work alone is not a benchmarked job', () => {
    const r = detectPackage([line(OILFILTER)], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
  });

  it('work marked as forcing a custom benchmark does exactly that', () => {
    const r = detectPackage([line(OIL), line(TUNEUP)], map);
    expect(r.packageType).toBe('CUSTOM_UNBENCHMARKED');
    expect(r.forcesCustomServiceTypeIds).toEqual([TUNEUP]);
    expect(r.reason).toMatch(/additional work/i);
  });

  it('distinguishes deliberate additional work from a service nobody has mapped', () => {
    // Both end in CUSTOM_UNBENCHMARKED, but only one is an outstanding admin task.
    const deliberate = detectPackage([line(OIL), line(TUNEUP)], map);
    const unmapped = detectPackage([line(OIL), line(AIRCON)], map);

    expect(deliberate.forcesCustomServiceTypeIds).toEqual([TUNEUP]);
    expect(deliberate.unmappedServiceTypeIds).toEqual([]);

    expect(unmapped.unmappedServiceTypeIds).toEqual([AIRCON]);
    expect(unmapped.forcesCustomServiceTypeIds).toEqual([]);
    expect(unmapped.reason).toMatch(/not mapped/i);
  });

  it('reports every blocker at once rather than one at a time', () => {
    const r = detectPackage([line(OIL), line(DISC), line(AIRCON), line(TUNEUP)], map);
    expect(r.reason).toMatch(/not mapped/i);
    expect(r.reason).toMatch(/additional work/i);
    expect(r.reason).toMatch(/no axle recorded/i);
  });
});
