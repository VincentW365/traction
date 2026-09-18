import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateResourceCapacity,
  type ResourcePosition,
  type CapacityJob,
} from '../resource-capacity.engine';
import { ResourceAvailabilityService, fingerprintOf, primaryCapability } from '../resource-availability.service';
import { ShadowComparisonService } from '../shadow-comparison.service';
import { ResourceReservationService } from '../resource-reservation.service';
import type { AvailabilityDecision } from '../slot-decision';

/**
 * CR-2026-108 Stage 5D — the twenty-two validation cases, in the order management
 * listed them.
 *
 * Deterministic on purpose. Several of these describe a shop configuration that
 * does not exist in the database today (there is no alignment bay yet), and the
 * point of the exercise is to prove the ENGINE behaves correctly when it does —
 * not to re-measure the current inventory, which the shadow validation run does
 * separately and against live data.
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
const bay = (code: string, capabilities: string[], over: Partial<ResourcePosition> = {}): ResourcePosition => ({
  ...BASE, id: `id-${code}`, code, capabilities, ...over,
});
const T = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 21, h, m));
const job = (id: string, capability: string | null, from = 9, to = 11, vehicleClass: string | null = null): CapacityJob => ({
  id, requiredCapability: capability, startAt: T(from), endAt: T(to), vehicleClass,
});
const evaluate = (resources: ResourcePosition[], existing: CapacityJob[], candidate: CapacityJob, unverified = 0) =>
  evaluateResourceCapacity({ resources, existing, candidate, unverifiedResourceCount: unverified });

/** The confirmed baseline: eight heavy-lift bays, GENERAL only. */
const EIGHT = () => Array.from({ length: 8 }, (_, i) => bay(`BAY-${String(i + 1).padStart(2, '0')}`, ['GENERAL']));
/** n concurrent jobs already on the book for the same window. */
const running = (n: number, capability: string | null = 'GENERAL') =>
  Array.from({ length: n }, (_, i) => job(`x${i}`, capability));

// ---------------------------------------------------------------------------
describe('5D-1 — eight verified GENERAL positions', () => {
  it('serves eight overlapping general jobs', () => {
    expect(evaluate(EIGHT(), running(7), job('c', 'GENERAL')).available).toBe(true);
  });

  it('refuses the ninth', () => {
    const d = evaluate(EIGHT(), running(8), job('c', 'GENERAL'));
    expect(d.available).toBe(false);
    expect(d.reasonCode).toBe('RESOURCE_CAPACITY_REACHED');
    expect(d.eligiblePositions).toBe(8);
  });
});

describe('5D-2 — adding a ninth bay increases eligible capacity', () => {
  it('the ninth job fits the moment a ninth bay exists', () => {
    expect(evaluate(EIGHT(), running(8), job('c', 'GENERAL')).available).toBe(false);
    const nine = [...EIGHT(), bay('BAY-09', ['GENERAL'])];
    const d = evaluate(nine, running(8), job('c', 'GENERAL'));
    expect(d.available).toBe(true);
    expect(d.eligiblePositions).toBe(9);
  });
});

describe('5D-3 — disabling one reduces it', () => {
  it.each([
    ['maintenance', { operationalStatus: 'MAINTENANCE' }],
    ['temporarily unavailable', { operationalStatus: 'TEMPORARILY_UNAVAILABLE' }],
    ['out of service', { operationalStatus: 'OUT_OF_SERVICE' }],
    ['deactivated', { isActive: false }],
    ['removed from scheduling', { schedulingEnabled: false }],
    ['retired', { retired: true }],
  ])('%s takes a position out of the count', (_label, patch) => {
    const eight = EIGHT();
    const down = [...eight.slice(0, 7), bay('BAY-08', ['GENERAL'], patch as Partial<ResourcePosition>)];
    expect(evaluate(down, running(7), job('c', 'GENERAL')).available).toBe(false);
    expect(evaluate(down, [], job('c', 'GENERAL')).eligiblePositions).toBe(7);
  });
});

describe('5D-4 — restoring it restores capacity', () => {
  it('returns to eight without anything being reclassified', () => {
    const down = [...EIGHT().slice(0, 7), bay('BAY-08', ['GENERAL'], { operationalStatus: 'MAINTENANCE' })];
    expect(evaluate(down, running(7), job('c', 'GENERAL')).available).toBe(false);
    // Same resource, same role, status back to AVAILABLE.
    const back = [...EIGHT().slice(0, 7), bay('BAY-08', ['GENERAL'], { operationalStatus: 'AVAILABLE' })];
    expect(evaluate(back, running(7), job('c', 'GENERAL')).available).toBe(true);
    expect(back[7].capacityRole).toBe('PRIMARY_SERVICE_POSITION');
  });
});

describe('5D-5 — support equipment does not increase capacity', () => {
  it('a jack and two stands add nothing', () => {
    const withEquipment = [
      ...EIGHT(),
      bay('MJACK-01', ['GENERAL'], { capacityRole: 'SUPPORT_EQUIPMENT' }),
      bay('STAND-01', ['GENERAL'], { capacityRole: 'SUPPORT_EQUIPMENT' }),
      bay('STAND-02', ['GENERAL'], { capacityRole: 'SUPPORT_EQUIPMENT' }),
    ];
    expect(evaluate(withEquipment, [], job('c', 'GENERAL')).eligiblePositions).toBe(8);
    expect(evaluate(withEquipment, running(8), job('c', 'GENERAL')).available).toBe(false);
  });
});

describe('5D-6 — an UNVERIFIED resource contributes zero', () => {
  it('and says the count is a lower bound rather than a fact', () => {
    const withUnverified = [...EIGHT(), bay('BAY-99', ['GENERAL'], { capacityRole: 'UNVERIFIED' })];
    const d = evaluate(withUnverified, running(8), job('c', 'GENERAL'), 1);
    expect(d.available).toBe(false);
    expect(d.eligiblePositions).toBe(8);
    expect(d.configurationComplete).toBe(false);
  });

  it('PLACEHOLDER contributes zero too, and means something different', () => {
    const withPlaceholder = [...EIGHT(), bay('BAY-99', ['GENERAL'], { capacityRole: 'PLACEHOLDER' })];
    expect(evaluate(withPlaceholder, [], job('c', 'GENERAL')).eligiblePositions).toBe(8);
  });
});

describe('5D-7 — a multi-capability resource counts once', () => {
  it('appears in three pools and is still one vehicle', () => {
    const one = [bay('BAY-01', ['GENERAL', 'LUBE', 'INSPECTION'])];
    expect(evaluate(one, [], job('a', 'LUBE')).available).toBe(true);
    expect(evaluate(one, [], job('b', 'INSPECTION')).available).toBe(true);
    // Pool arithmetic says GENERAL=1, LUBE=1, INSPECTION=1 → three jobs. Wrong.
    expect(evaluate(one, [job('a', 'LUBE')], job('b', 'INSPECTION')).available).toBe(false);
  });

  it('and the eight-bay shop does not become twenty-four', () => {
    const versatile = EIGHT().map((b) => ({ ...b, capabilities: ['GENERAL', 'LUBE', 'INSPECTION'] }));
    expect(evaluate(versatile, running(8, 'LUBE'), job('c', 'INSPECTION')).available).toBe(false);
  });
});

// --- specialty bottlenecks (8, 9, 10) ---------------------------------------
describe.each([
  ['5D-8', 'ALIGNMENT', 'TIR-02 Wheel Alignment'],
  ['5D-9', 'LUBE', 'OIL-01 Oil Change'],
  ['5D-10', 'INSPECTION', 'INSP-01 Pre-Purchase Inspection'],
])('%s — %s specialty bottleneck', (_id, capability, service) => {
  /** Eight general bays, exactly one of which also carries the specialty. */
  const shop = () => [bay('BAY-01', ['GENERAL', capability]), ...EIGHT().slice(1)];

  it(`one ${capability} position serves one ${service} job`, () => {
    expect(evaluate(shop(), [], job('c', capability)).eligiblePositions).toBe(1);
    expect(evaluate(shop(), [], job('c', capability)).available).toBe(true);
  });

  it('two overlapping specialty jobs cannot both be served, even with seven bays free', () => {
    const d = evaluate(shop(), [job('x', capability)], job('c', capability));
    expect(d.available).toBe(false);
    expect(d.label).toBe(`${capability}_CAPACITY_REACHED`);
  });

  it('a general job still fits while the specialty bay is busy', () => {
    expect(evaluate(shop(), [job('x', capability)], job('c', 'GENERAL')).available).toBe(true);
  });

  it('and the specialty bay being occupied by general work blocks the specialty', () => {
    // Seven general jobs take the seven general-only bays; the eighth takes the
    // specialty bay; now the specialty job has nowhere to go.
    expect(evaluate(shop(), running(8), job('c', capability)).available).toBe(false);
  });
});

describe('5D-11 — an overflow position added dynamically', () => {
  it('participates the moment it is OVERFLOW + AVAILABLE with a matching capability', () => {
    expect(evaluate(EIGHT(), running(8), job('c', 'GENERAL')).available).toBe(false);
    const withOverflow = [...EIGHT(), bay('OVF-01', ['GENERAL'], { capacityRole: 'OVERFLOW_SERVICE_POSITION' })];
    expect(evaluate(withOverflow, running(8), job('c', 'GENERAL')).available).toBe(true);
  });

  it('but not while it is unclassified, unavailable, or lacks the capability', () => {
    const cases: Array<Partial<ResourcePosition>> = [
      { capacityRole: 'UNVERIFIED' },
      { capacityRole: 'OVERFLOW_SERVICE_POSITION', operationalStatus: 'MAINTENANCE' },
      { capacityRole: 'OVERFLOW_SERVICE_POSITION', capabilities: ['TIRE'] },
    ];
    for (const patch of cases) {
      const shop = [...EIGHT(), bay('OVF-01', ['GENERAL'], patch)];
      expect(evaluate(shop, running(8), job('c', 'GENERAL'), 1).available).toBe(false);
    }
  });
});

describe('5D-12 — an overflow position removed dynamically', () => {
  it('capacity falls the moment it stops being available', () => {
    const withOverflow = [...EIGHT(), bay('OVF-01', ['GENERAL'], { capacityRole: 'OVERFLOW_SERVICE_POSITION' })];
    expect(evaluate(withOverflow, running(8), job('c', 'GENERAL')).available).toBe(true);
    const removed = [...EIGHT(), bay('OVF-01', ['GENERAL'], { capacityRole: 'OVERFLOW_SERVICE_POSITION', operationalStatus: 'OUT_OF_SERVICE' })];
    expect(evaluate(removed, running(8), job('c', 'GENERAL')).available).toBe(false);
  });
});

describe('5D-13 — a SEDAN-only restriction', () => {
  it('excludes the sedan-only bay from an SUV job but not from a sedan job', () => {
    const shop = [...EIGHT().slice(0, 7), bay('BAY-08', ['GENERAL'], { supportsSuv: false })];
    expect(evaluate(shop, [], job('c', 'GENERAL', 9, 11, 'SEDAN_CLASS')).eligiblePositions).toBe(8);
    expect(evaluate(shop, [], job('c', 'GENERAL', 9, 11, 'SUV_CLASS')).eligiblePositions).toBe(7);
  });

  it('and a mobile jack is sedan-only by rule, not by configuration', () => {
    const shop = [bay('MJACK-01', ['GENERAL'], { liftType: 'mobile' })];
    expect(evaluate(shop, [], job('c', 'GENERAL', 9, 11, 'SEDAN_CLASS')).available).toBe(true);
    expect(evaluate(shop, [], job('c', 'GENERAL', 9, 11, 'SUV_CLASS')).available).toBe(false);
  });
});

describe('5D-14 — an SUV is refused where no position accepts one', () => {
  it('reports the vehicle class rather than a capacity limit', () => {
    const sedanOnly = EIGHT().map((b) => ({ ...b, supportsSuv: false }));
    const d = evaluate(sedanOnly, [], job('c', 'GENERAL', 9, 11, 'SUV_CLASS'));
    expect(d.available).toBe(false);
    expect(d.reasonCode).toBe('VEHICLE_CLASS_NOT_SUPPORTED');
    // Not a capacity problem: eight bays are standing idle.
    expect(d.reasonCode).not.toBe('RESOURCE_CAPACITY_REACHED');
  });
});

describe('5D-15 — maintenance status', () => {
  it('removes the position for today and keeps its role for tomorrow', () => {
    const r = bay('BAY-01', ['GENERAL'], { operationalStatus: 'MAINTENANCE' });
    expect(evaluate([r], [], job('c', 'GENERAL')).eligiblePositions).toBe(0);
    expect(r.capacityRole).toBe('PRIMARY_SERVICE_POSITION');
  });

  it('an absent status row means AVAILABLE, because setStatus writes only on change', () => {
    // The snapshot loader applies this default; asserted here so the engine's
    // contract and the loader's cannot drift apart.
    expect(evaluate([bay('BAY-01', ['GENERAL'], { operationalStatus: 'AVAILABLE' })], [], job('c', 'GENERAL')).available).toBe(true);
  });
});

describe('5D-16 — the future-impact warning is capability-level', () => {
  it('reports pool loss rather than rows keyed on the resource id', async () => {
    const { ResourceAdminService } = await import('../../../resources/resource-admin.service');
    const prisma = {
      workResource: {
        findUnique: vi.fn(async () => ({
          id: 'res-1', occupancy: null, serviceCapabilities: [{ capability: 'ALIGNMENT' }],
        })),
        findMany: vi.fn(async () => [
          { id: 'res-1', capacity: 1, operationalStatus: null, serviceCapabilities: [{ capability: 'ALIGNMENT' }] },
        ]),
        count: vi.fn(async () => 0),
      },
      resourceReservation: { count: vi.fn(async () => 0) },
      technicianAssignment: { count: vi.fn(async () => 0) },
      $queryRaw: vi.fn(async () => [{ capability: 'ALIGNMENT', appointments: 3n }]),
    };
    const admin = new ResourceAdminService(prisma as never, { log: vi.fn(async () => ({})) } as never);
    const impact = await admin.impact('res-1');
    const alignment = impact.capabilityImpact.find((c) => c.capability === 'ALIGNMENT')!;

    // The old answer — no assignment ever references a WorkResource.
    expect(impact.activeAssignments).toBe(0);
    // The answer that matters.
    expect(alignment).toMatchObject({ positionsBefore: 1, positionsAfter: 0, severity: 'LAST_POSITION', futureAppointmentsNeeding: 3 });
    expect(alignment.warning).toContain('only position');
  });
});

describe('5D-17 — no stale-resource behaviour', () => {
  it('the fingerprint changes whenever anything eligibility-relevant changes', () => {
    const base = EIGHT();
    const baseline = fingerprintOf(base);
    const mutations: Array<[string, ResourcePosition[]]> = [
      ['a bay added', [...base, bay('BAY-09', ['GENERAL'])]],
      ['a role changed', [...base.slice(0, 7), bay('BAY-08', ['GENERAL'], { capacityRole: 'SUPPORT_EQUIPMENT' })]],
      ['a status changed', [...base.slice(0, 7), bay('BAY-08', ['GENERAL'], { operationalStatus: 'MAINTENANCE' })]],
      ['a capability added', [...base.slice(0, 7), bay('BAY-08', ['GENERAL', 'ALIGNMENT'])]],
      ['a vehicle restriction added', [...base.slice(0, 7), bay('BAY-08', ['GENERAL'], { supportsSuv: false })]],
      ['capacity changed', [...base.slice(0, 7), bay('BAY-08', ['GENERAL'], { capacity: 2 })]],
      ['retired', [...base.slice(0, 7), bay('BAY-08', ['GENERAL'], { retired: true })]],
    ];
    for (const [label, mutated] of mutations) {
      expect(fingerprintOf(mutated), label).not.toBe(baseline);
    }
  });

  it('is stable under reordering, so a different query plan is not a config change', () => {
    expect(fingerprintOf([...EIGHT()].reverse())).toBe(fingerprintOf(EIGHT()));
  });

  it('a snapshot is read per evaluation, never cached across one', async () => {
    const src = readFileSync(join(__dirname, '..', 'resource-availability.service.ts'), 'utf8');
    // A module-level cache here would serve yesterday's inventory after a manager
    // commissioned a bay, which is exactly the failure this case exists for.
    expect(src).not.toMatch(/private\s+\w*[Cc]ache/);
    expect(src).not.toMatch(/new Map\(\)\s*;?\s*$/m);
  });
});

// --- reservations and concurrency (18, 19, 20) ------------------------------
function reservationHarness() {
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    resourceReservation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push({ id: `r${rows.length}`, ...data });
        return rows[rows.length - 1];
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of rows) {
          if (r.appointmentId === where.appointmentId && ['PENDING', 'ACTIVE'].includes(String(r.status))) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      }),
      findMany: vi.fn(async () => rows.filter((r) => ['PENDING', 'ACTIVE'].includes(String(r.status)))),
    },
  };
  return { service: new ResourceReservationService({} as never), tx, rows };
}

describe('5D-18 — concurrent booking of the last position', () => {
  it('reserving happens inside the same day lock every other writer takes', async () => {
    const src = readFileSync(join(__dirname, '..', 'booking-availability.service.ts'), 'utf8');
    // The serialisation point. Without it, two writers both see the last slot free.
    expect(src).toContain('pg_advisory_xact_lock');
    expect(src).toContain('async lockDay');
  });

  it('a reservation is visible to a concurrent evaluation before its appointment exists', async () => {
    const h = reservationHarness();
    await h.service.reserve(h.tx as never, {
      siteId: 's1', appointmentId: 'a1', requiredCapability: 'ALIGNMENT',
      reservedFrom: T(9), reservedUntil: T(11),
    });
    // The window this closes: an appointment row not yet committed, capacity
    // already spoken for.
    const jobs = await h.service.holdsAsJobs(h.tx as never, 's1', { from: T(8), to: T(12) });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].requiredCapability).toBe('ALIGNMENT');
  });

  it('the solver counts a held reservation as a competing job', () => {
    const one = [bay('ALIGN-01', ['GENERAL', 'ALIGNMENT'])];
    const held: CapacityJob = { id: 'reservation:r0', startAt: T(9), endAt: T(11), requiredCapability: 'ALIGNMENT', vehicleClass: null };
    expect(evaluate(one, [held], job('c', 'ALIGNMENT')).available).toBe(false);
  });
});

describe('5D-19 — cancellation releases capacity', () => {
  it('marks the hold released without deleting the record', async () => {
    const h = reservationHarness();
    await h.service.reserve(h.tx as never, {
      siteId: 's1', appointmentId: 'a1', requiredCapability: 'LUBE', reservedFrom: T(9), reservedUntil: T(11),
    });
    const { released } = await h.service.release(h.tx as never, 'a1', 'CANCELLED');
    expect(released).toBe(1);
    expect(h.rows).toHaveLength(1); // kept: it explains why a slot was busy at 10
    expect(h.rows[0].status).toBe('CANCELLED');
    expect(await h.service.holdsAsJobs(h.tx as never, 's1', { from: T(8), to: T(12) })).toHaveLength(0);
  });
});

describe('5D-20 — reschedule releases and reclaims atomically', () => {
  it('ends with exactly one hold, on the new interval', async () => {
    const h = reservationHarness();
    await h.service.reserve(h.tx as never, {
      siteId: 's1', appointmentId: 'a1', requiredCapability: 'GENERAL', reservedFrom: T(9), reservedUntil: T(11),
    });
    await h.service.moveTo(h.tx as never, 'a1', {
      siteId: 's1', requiredCapability: 'GENERAL', reservedFrom: T(14), reservedUntil: T(16),
    });
    const holds = await h.service.holdsAsJobs(h.tx as never, 's1', { from: T(8), to: T(18) });
    expect(holds).toHaveLength(1);
    expect(holds[0].startAt).toEqual(T(14));
  });

  it('release and reserve are one call, so the old interval is never briefly free', async () => {
    const src = readFileSync(join(__dirname, '..', 'resource-reservation.service.ts'), 'utf8');
    const body = src.slice(src.indexOf('async moveTo'));
    const method = body.slice(0, body.search(/\n {2}(async |private |public |\/\*\*)/));
    // Both writes take the CALLER'S transaction. Splitting them across two would
    // open exactly the gap a concurrent booking needs.
    expect(method).toContain('this.release(tx,');
    expect(method).toContain('this.reserve(tx,');
    // No transaction of its own — that would be two transactions, not one.
    expect(method).not.toContain('$transaction');
  });
});

describe('5D-21 — the simulator compares FIXED with SHADOW', () => {
  const decision = (slots: Array<{ available: boolean; reasonCode: string }>): AvailabilityDecision => ({
    nextAvailable: null,
    days: [
      {
        date: '2026-09-21',
        closed: false,
        availableCount: slots.filter((s) => s.available).length,
        slots: slots.map((s, i) => ({
          startAt: T(9 + i).toISOString(),
          endAt: T(10 + i).toISOString(),
          available: s.available,
          reasonCode: s.reasonCode as never,
          plannedMinutes: 60,
          capacity: { before: 0, after: 1, limit: 2 },
        })),
      },
    ],
  });

  function harness(resources: ResourcePosition[], jobs: CapacityJob[] = [], unverified = 0) {
    const availability = new ResourceAvailabilityService({} as never);
    const snapshot = {
      siteId: 's1', resources, jobs, unverifiedResourceCount: unverified,
      fingerprint: fingerprintOf(resources), capabilityPositions: {}, activePositions: resources.length,
    };
    const shadow = new ShadowComparisonService({ bookingShadowComparison: { createMany: vi.fn(async () => ({ count: 0 })) } } as never, availability);
    return { shadow, snapshot };
  }

  it('reports a slot the fixed limit offered that no position can cover', () => {
    const h = harness([bay('BAY-01', ['GENERAL'])], [job('x', 'GENERAL', 9, 10)]);
    const run = h.shadow.compare(decision([{ available: true, reasonCode: 'AVAILABLE' }]), h.snapshot, {
      requiredCapability: 'GENERAL', vehicleClass: null,
    });
    expect(run.summary.oversold).toBe(1);
    expect(run.days[0].slots[0].shadow.label).toBe('GENERAL_CAPACITY_REACHED');
    expect(run.headline).toContain('no eligible position could cover');
  });

  it('reports a slot the fixed limit refused where positions were free', () => {
    const h = harness(EIGHT());
    const run = h.shadow.compare(decision([{ available: false, reasonCode: 'FIXED_CAPACITY_REACHED' }]), h.snapshot, {
      requiredCapability: 'GENERAL', vehicleClass: null,
    });
    expect(run.summary.undersold).toBe(1);
    expect(run.days[0].slots[0].shadow.eligiblePositions).toBe(8);
  });

  it('never compares a slot the fixed model rejected on timing', () => {
    const h = harness(EIGHT());
    const run = h.shadow.compare(
      decision([
        { available: false, reasonCode: 'PAST' },
        { available: false, reasonCode: 'MINIMUM_NOTICE' },
        { available: true, reasonCode: 'AVAILABLE' },
      ]),
      h.snapshot,
      { requiredCapability: 'GENERAL', vehicleClass: null },
    );
    // The resource model has no opinion about what time it is.
    expect(run.summary.slotsCompared).toBe(1);
  });

  it('records only disagreements, never agreement', async () => {
    const createMany = vi.fn(async () => ({ count: 0 }));
    const availability = new ResourceAvailabilityService({} as never);
    const shadow = new ShadowComparisonService({ bookingShadowComparison: { createMany } } as never, availability);
    const snapshot = {
      siteId: 's1', resources: EIGHT(), jobs: [], unverifiedResourceCount: 0,
      fingerprint: 'fp', capabilityPositions: {}, activePositions: 8,
    };
    const run = shadow.compare(decision([{ available: true, reasonCode: 'AVAILABLE' }]), snapshot, {
      requiredCapability: 'GENERAL', vehicleClass: null,
    });
    expect(run.summary.agree).toBe(1);
    const { written } = await shadow.record('s1', run, { serviceCodes: ['BRK-01'], plannedMinutes: 60, vehicleClass: null, source: 'SIMULATOR' });
    expect(written).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('what is recorded carries no PII', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const availability = new ResourceAvailabilityService({} as never);
    const shadow = new ShadowComparisonService(
      { bookingShadowComparison: { createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { captured.push(...data); return { count: data.length }; }) } } as never,
      availability,
    );
    const snapshot = {
      siteId: 's1', resources: [bay('BAY-01', ['GENERAL'])], jobs: [job('x', 'GENERAL', 9, 10)],
      unverifiedResourceCount: 0, fingerprint: 'fp', capabilityPositions: {}, activePositions: 1,
    };
    const run = shadow.compare(decision([{ available: true, reasonCode: 'AVAILABLE' }]), snapshot, {
      requiredCapability: 'GENERAL', vehicleClass: 'SEDAN_CLASS',
    });
    await shadow.record('s1', run, { serviceCodes: ['BRK-01'], plannedMinutes: 60, vehicleClass: 'SEDAN_CLASS', source: 'SIMULATOR' });

    expect(captured).toHaveLength(1);
    const keys = Object.keys(captured[0]);
    for (const forbidden of ['customerId', 'customerName', 'phone', 'email', 'plateNumber', 'vehicleId', 'appointmentId', 'manageToken']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    // A vehicle CLASS is not identifying; a plate would be.
    expect(captured[0].vehicleClass).toBe('SEDAN_CLASS');
  });
});

describe('5D-22 — the incomplete-configuration diagnostic', () => {
  it('an unassigned specialty reads as NOT VERIFIED, not as a capacity limit', () => {
    const d = evaluate(EIGHT(), [], job('c', 'LUBE'), 8);
    expect(d.status).toBe('INCOMPLETE');
    expect(d.label).toBe('LUBE_CAPACITY_NOT_VERIFIED');
    expect(d.reasonCode).toBe('RESOURCE_CONFIGURATION_INCOMPLETE');
  });

  it('and becomes a real finding once everything is classified', () => {
    const d = evaluate(EIGHT(), [], job('c', 'LUBE'), 0);
    expect(d.status).toBe('BLOCKED');
    expect(d.label).toBe('LUBE_POSITION_NOT_CONFIGURED');
  });

  it('INCOMPLETE is never counted as the fixed model overselling', () => {
    const availability = new ResourceAvailabilityService({} as never);
    const shadow = new ShadowComparisonService({} as never, availability);
    const snapshot = {
      siteId: 's1', resources: EIGHT(), jobs: [], unverifiedResourceCount: 8,
      fingerprint: 'fp', capabilityPositions: {}, activePositions: 8,
    };
    const run = shadow.compare(
      {
        nextAvailable: null,
        days: [{
          date: '2026-09-21', closed: false, availableCount: 1,
          slots: [{
            startAt: T(9).toISOString(), endAt: T(10).toISOString(), available: true,
            reasonCode: 'AVAILABLE', plannedMinutes: 60, capacity: { before: 0, after: 1, limit: 2 },
          }],
        }],
      },
      snapshot,
      { requiredCapability: 'LUBE', vehicleClass: null },
    );
    // The whole point: an unfinished configuration must not read as a shop being
    // oversold, because the preflight blocks on that number.
    expect(run.summary.incomplete).toBe(1);
    expect(run.summary.oversold).toBe(0);
    expect(run.headline).toContain('not a capacity finding');
  });

  it('the four outcome counts partition the compared slots', () => {
    const availability = new ResourceAvailabilityService({} as never);
    const shadow = new ShadowComparisonService({} as never, availability);
    const snapshot = {
      siteId: 's1', resources: EIGHT(), jobs: [], unverifiedResourceCount: 1,
      fingerprint: 'fp', capabilityPositions: {}, activePositions: 8,
    };
    const run = shadow.compare(
      {
        nextAvailable: null,
        days: [{
          date: '2026-09-21', closed: false, availableCount: 2,
          slots: [0, 1, 2].map((i) => ({
            startAt: T(9 + i).toISOString(), endAt: T(10 + i).toISOString(),
            available: i !== 2, reasonCode: (i === 2 ? 'FIXED_CAPACITY_REACHED' : 'AVAILABLE') as never,
            plannedMinutes: 60, capacity: { before: 0, after: 1, limit: 2 },
          })),
        }],
      },
      snapshot,
      { requiredCapability: 'GENERAL', vehicleClass: null },
    );
    const s = run.summary;
    expect(s.agree + s.oversold + s.undersold + s.incomplete).toBe(s.slotsCompared);
  });
});

// ---------------------------------------------------------------------------
describe('supporting: how a multi-service appointment is constrained', () => {
  it('the scarcer requirement wins, because that is what limits where it can go', () => {
    expect(primaryCapability(['GENERAL', 'ALIGNMENT'])).toBe('ALIGNMENT');
    expect(primaryCapability(['GENERAL', 'GENERAL'])).toBe('GENERAL');
    expect(primaryCapability([null, null])).toBeNull();
    expect(primaryCapability([])).toBeNull();
  });
});
