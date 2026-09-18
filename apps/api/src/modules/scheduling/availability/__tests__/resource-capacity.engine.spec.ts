import { describe, it, expect } from 'vitest';
import {
  evaluateResourceCapacity,
  canServe,
  isCountablePosition,
  maxMatching,
  composeLabel,
  type ResourcePosition,
  type CapacityJob,
} from '../resource-capacity.engine';

/**
 * CR-2026-108 Stage 5C — the solver.
 *
 * Most of what follows exists to pin ONE property: capability pools are not
 * additive, because the same bay appears in several of them. The test that
 * matters most is `a multi-capability bay is still one vehicle at a time` — it is
 * the difference between eight bays and thirteen promises.
 */

const BASE: Omit<ResourcePosition, 'id' | 'code' | 'capabilities'> = {
  capacityRole: 'PRIMARY_SERVICE_POSITION',
  capacity: 1,
  isActive: true,
  retired: false,
  schedulingEnabled: true,
  operationalStatus: 'AVAILABLE',
  supportsSedan: true,
  supportsSuv: true,
  liftType: null,
};

function bay(code: string, capabilities: string[], over: Partial<ResourcePosition> = {}): ResourcePosition {
  return { ...BASE, id: `id-${code}`, code, capabilities, ...over };
}

const T = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 21, h, m));
function job(id: string, capability: string | null, fromH: number, toH: number, vehicleClass: string | null = null): CapacityJob {
  return { id, requiredCapability: capability, startAt: T(fromH), endAt: T(toH), vehicleClass };
}

function evaluate(resources: ResourcePosition[], existing: CapacityJob[], candidate: CapacityJob, unverified = 0) {
  return evaluateResourceCapacity({ resources, existing, candidate, unverifiedResourceCount: unverified });
}

// ---------------------------------------------------------------------------
describe('§8 — physical identity, not pool arithmetic', () => {
  /**
   * The headline case from the CR. Bay 3 does GENERAL and INSPECTION. Summing
   * pools says two jobs fit. The building says one vehicle.
   */
  it('a multi-capability bay is still one vehicle at a time', () => {
    const only = [bay('BAY-3', ['GENERAL', 'INSPECTION'])];
    const inspection = job('a', 'INSPECTION', 9, 11);
    const general = job('b', 'GENERAL', 9, 11);

    // Each alone is fine.
    expect(evaluate(only, [], inspection).available).toBe(true);
    // Together they are not — pool arithmetic would have said GENERAL=1,
    // INSPECTION=1, therefore two jobs.
    const both = evaluate(only, [inspection], general);
    expect(both.available).toBe(false);
    expect(both.reasonCode).toBe('RESOURCE_CAPACITY_REACHED');
    expect(both.label).toBe('GENERAL_CAPACITY_REACHED');
  });

  it('never adds pools together to justify a slot', () => {
    // 1 GENERAL-only, 1 ALIGNMENT-only, 1 that does both. Pools read 2 and 2.
    const shop = [bay('G1', ['GENERAL']), bay('A1', ['ALIGNMENT']), bay('B1', ['GENERAL', 'ALIGNMENT'])];
    // Two alignments already running consume A1 and B1.
    const running = [job('x', 'ALIGNMENT', 9, 11), job('y', 'ALIGNMENT', 9, 11)];
    // A third alignment has nowhere to go even though "ALIGNMENT = 2".
    expect(evaluate(shop, running, job('z', 'ALIGNMENT', 9, 11)).available).toBe(false);
    // But a GENERAL job still fits, because G1 is untouched.
    expect(evaluate(shop, running, job('w', 'GENERAL', 9, 11)).available).toBe(true);
  });

  /**
   * The subtle one: a greedy assignment fails here, a matching succeeds. B1 is
   * the only bay that can do ALIGNMENT, so the GENERAL job must take G1 — an
   * algorithm that hands B1 to the general job first would wrongly report BLOCKED.
   */
  it('re-assigns jobs rather than failing on a greedy first choice', () => {
    const shop = [bay('G1', ['GENERAL']), bay('B1', ['GENERAL', 'ALIGNMENT'])];
    const general = job('g', 'GENERAL', 9, 11);
    expect(evaluate(shop, [general], job('a', 'ALIGNMENT', 9, 11)).available).toBe(true);
  });

  it('checks every instant, not just the start of the interval', () => {
    const shop = [bay('B1', ['GENERAL']), bay('B2', ['GENERAL'])];
    // Candidate 9-12. One job overlaps from 9, another starts at 10. At 10 there
    // are three jobs and only two bays.
    const decision = evaluate(shop, [job('x', 'GENERAL', 9, 12), job('y', 'GENERAL', 10, 12)], job('c', 'GENERAL', 9, 12));
    expect(decision.available).toBe(false);
    expect(decision.peakConcurrentJobs).toBe(3);
  });

  it('a resource that genuinely holds two vehicles counts as two positions', () => {
    const shop = [bay('DOUBLE', ['GENERAL'], { capacity: 2 })];
    expect(evaluate(shop, [job('x', 'GENERAL', 9, 11)], job('c', 'GENERAL', 9, 11)).available).toBe(true);
    expect(evaluate(shop, [job('x', 'GENERAL', 9, 11), job('y', 'GENERAL', 9, 11)], job('c', 'GENERAL', 9, 11)).available).toBe(false);
  });

  it('back-to-back jobs do not overlap', () => {
    const shop = [bay('B1', ['GENERAL'])];
    expect(evaluate(shop, [job('x', 'GENERAL', 8, 9)], job('c', 'GENERAL', 9, 11)).available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('what counts as a position at all', () => {
  it('UNVERIFIED, PLACEHOLDER and SUPPORT_EQUIPMENT contribute nothing', () => {
    for (const capacityRole of ['UNVERIFIED', 'PLACEHOLDER', 'SUPPORT_EQUIPMENT']) {
      expect(isCountablePosition(bay('X', ['GENERAL'], { capacityRole }))).toBe(false);
    }
    expect(isCountablePosition(bay('X', ['GENERAL'], { capacityRole: 'PRIMARY_SERVICE_POSITION' }))).toBe(true);
    expect(isCountablePosition(bay('X', ['GENERAL'], { capacityRole: 'OVERFLOW_SERVICE_POSITION' }))).toBe(true);
  });

  it('operational status is a separate dimension from role', () => {
    for (const operationalStatus of ['MAINTENANCE', 'TEMPORARILY_UNAVAILABLE', 'OUT_OF_SERVICE']) {
      expect(isCountablePosition(bay('X', ['GENERAL'], { operationalStatus }))).toBe(false);
    }
  });

  it('inactive, retired and descheduled are all excluded', () => {
    expect(isCountablePosition(bay('X', ['GENERAL'], { isActive: false }))).toBe(false);
    expect(isCountablePosition(bay('X', ['GENERAL'], { retired: true }))).toBe(false);
    expect(isCountablePosition(bay('X', ['GENERAL'], { schedulingEnabled: false }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('vehicle restrictions', () => {
  it('a sedan-only bay refuses an SUV', () => {
    const shop = [bay('S1', ['GENERAL'], { supportsSuv: false })];
    const d = evaluate(shop, [], job('c', 'GENERAL', 9, 11, 'SUV_CLASS'));
    expect(d.available).toBe(false);
    expect(d.reasonCode).toBe('VEHICLE_CLASS_NOT_SUPPORTED');
    expect(d.label).toBe('GENERAL_VEHICLE_CLASS_NOT_SUPPORTED');
  });

  it('an SUV-only bay refuses a sedan', () => {
    const shop = [bay('U1', ['GENERAL'], { supportsSedan: false })];
    expect(evaluate(shop, [], job('c', 'GENERAL', 9, 11, 'SEDAN_CLASS')).reasonCode).toBe('VEHICLE_CLASS_NOT_SUPPORTED');
  });

  /** DMAIC Rule 3. The override is a dispatch decision, never an offered slot. */
  it('a mobile jack is sedan-only, and an unknown class does not get the benefit of the doubt', () => {
    const jack = bay('MJACK-01', ['GENERAL'], { liftType: 'mobile' });
    expect(canServe(jack, job('c', 'GENERAL', 9, 11, 'SEDAN_CLASS'))).toBe(true);
    expect(canServe(jack, job('c', 'GENERAL', 9, 11, 'SUV_CLASS'))).toBe(false);
    expect(canServe(jack, job('c', 'GENERAL', 9, 11, null))).toBe(false);
  });

  it('reports the vehicle as the problem when positions exist for the work', () => {
    const shop = [bay('S1', ['ALIGNMENT'], { supportsSuv: false })];
    const d = evaluate(shop, [], job('c', 'ALIGNMENT', 9, 11, 'SUV_CLASS'));
    expect(d.reasonCode).toBe('VEHICLE_CLASS_NOT_SUPPORTED');
    // Not "no alignment bay" — there is one, it just cannot take this vehicle.
    expect(d.reasonCode).not.toBe('REQUIRED_RESOURCE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
describe('INCOMPLETE is not a kind of BLOCKED', () => {
  it('an unclassified shop reports a configuration gap, not a capacity limit', () => {
    const shop = [bay('B1', ['GENERAL'], { capacityRole: 'UNVERIFIED' })];
    const d = evaluate(shop, [], job('c', 'GENERAL', 9, 11), 1);
    expect(d.status).toBe('INCOMPLETE');
    expect(d.reasonCode).toBe('RESOURCE_CONFIGURATION_INCOMPLETE');
    expect(d.label).toBe('GENERAL_CAPACITY_NOT_VERIFIED');
    expect(d.available).toBe(false);
  });

  it('a fully classified shop with no such bay reports a real operational fact', () => {
    const shop = [bay('B1', ['GENERAL'])];
    const d = evaluate(shop, [], job('c', 'TIRE', 9, 11), 0);
    expect(d.status).toBe('BLOCKED');
    expect(d.reasonCode).toBe('REQUIRED_RESOURCE_UNAVAILABLE');
    expect(d.label).toBe('TIRE_POSITION_NOT_CONFIGURED');
  });

  it('INCOMPLETE never reads as available', () => {
    const d = evaluate([], [], job('c', 'LUBE', 9, 11), 5);
    expect(d.status).toBe('INCOMPLETE');
    expect(d.available).toBe(false);
    expect(d.label).toBe('LUBE_CAPACITY_NOT_VERIFIED');
  });

  it('marks counts as a lower bound while anything is unclassified', () => {
    const shop = [bay('B1', ['GENERAL']), bay('B2', ['GENERAL'], { capacityRole: 'UNVERIFIED' })];
    const d = evaluate(shop, [], job('c', 'GENERAL', 9, 11), 1);
    expect(d.available).toBe(true);
    expect(d.configurationComplete).toBe(false);
    expect(d.detail).toContain('lower bound');
  });
});

// ---------------------------------------------------------------------------
describe('an unmapped service is not an impossible one', () => {
  it('a null required capability can use any position', () => {
    const shop = [bay('B1', ['GENERAL'])];
    expect(evaluate(shop, [], job('c', null, 9, 11)).available).toBe(true);
  });

  it('and still competes for the same physical position', () => {
    const shop = [bay('B1', ['GENERAL'])];
    expect(evaluate(shop, [job('x', 'GENERAL', 9, 11)], job('c', null, 9, 11)).available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the matching itself', () => {
  it('matches what it can and no more', () => {
    expect(maxMatching(2, [[0], [0]])).toBe(1);
    expect(maxMatching(2, [[0], [1]])).toBe(2);
    expect(maxMatching(3, [[0, 1], [0, 1], [0, 1]])).toBe(2);
    expect(maxMatching(1, [[]])).toBe(0);
    expect(maxMatching(0, [])).toBe(0);
  });

  it('finds an augmenting path rather than stopping at the first conflict', () => {
    // Job 0 can only use node 0; job 1 can use either. Greedy order would give
    // node 0 to job 1 and strand job 0.
    expect(maxMatching(2, [[0], [0, 1]])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('labels management asked for', () => {
  it('composes from the capability instead of enumerating every name', () => {
    expect(composeLabel('RESOURCE_CAPACITY_REACHED', 'ALIGNMENT')).toBe('ALIGNMENT_CAPACITY_REACHED');
    expect(composeLabel('RESOURCE_CONFIGURATION_INCOMPLETE', 'LUBE')).toBe('LUBE_CAPACITY_NOT_VERIFIED');
    // A capability invented next year needs no change here.
    expect(composeLabel('RESOURCE_CAPACITY_REACHED', 'CLEANING')).toBe('CLEANING_CAPACITY_REACHED');
    expect(composeLabel('AVAILABLE', 'GENERAL')).toBe('AVAILABLE');
    expect(composeLabel('RESOURCE_CAPACITY_REACHED', null)).toBe('CAPACITY_REACHED');
  });
});

// ---------------------------------------------------------------------------
describe('the eight-bay baseline', () => {
  const eight = Array.from({ length: 8 }, (_, i) => bay(`BAY-0${i + 1}`, ['GENERAL']));

  it('serves eight overlapping general jobs and refuses the ninth', () => {
    const running = Array.from({ length: 7 }, (_, i) => job(`x${i}`, 'GENERAL', 9, 11));
    expect(evaluate(eight, running, job('c', 'GENERAL', 9, 11)).available).toBe(true);
    expect(evaluate(eight, [...running, job('x7', 'GENERAL', 9, 11)], job('c', 'GENERAL', 9, 11)).available).toBe(false);
  });

  it('a ninth bay raises it, and taking one out lowers it', () => {
    const seven = Array.from({ length: 8 }, (_, i) => job(`x${i}`, 'GENERAL', 9, 11));
    expect(evaluate([...eight, bay('BAY-09', ['GENERAL'])], seven, job('c', 'GENERAL', 9, 11)).available).toBe(true);

    const oneDown = [...eight.slice(0, 7), bay('BAY-08', ['GENERAL'], { operationalStatus: 'MAINTENANCE' })];
    const sixRunning = Array.from({ length: 7 }, (_, i) => job(`x${i}`, 'GENERAL', 9, 11));
    expect(evaluate(oneDown, sixRunning, job('c', 'GENERAL', 9, 11)).available).toBe(false);
  });

  it('none of the eight does alignment unless someone says so', () => {
    const d = evaluate(eight, [], job('c', 'ALIGNMENT', 9, 11), 0);
    expect(d.available).toBe(false);
    expect(d.reasonCode).toBe('REQUIRED_RESOURCE_UNAVAILABLE');
  });
});
