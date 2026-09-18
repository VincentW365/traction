import { describe, it, expect, vi } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';
import { WalkInsService } from '../../walk-ins/walk-ins.service';
import { SERVICE_DURATION_SELECT, type MeasurableService } from '../../scheduling/availability/service-duration';

/**
 * CR-2026-111c §6 — the last duration divergence, closed.
 *
 * `ServiceOrderItem.estimateMinutes` used `baseDurationMinutes` directly, so an SUV
 * General Servicing became a 90-minute line on the work order while the same
 * vehicle's appointment was planned at 120. Walk-ins had the same flaw, which made
 * "drove in off the street" a quietly different duration policy.
 *
 * The estimate is NOT the booking reservation (§4). The calendar may still hold 80
 * minutes under the DEFAULT booking policy; once the order exists, what the work
 * actually takes is a separate and more specific fact. These tests assert the
 * estimate, and deliberately say nothing about the reservation.
 *
 * Mocks honour the Prisma `select`, carried over from CR-2026-111b: a fixture that
 * returns every column regardless of the query cannot detect a select regression,
 * and a test that cannot fail is decoration.
 */

/** The approved General Servicing standard: 90 sedan, 120 SUV. */
const GEN_SERV = {
  id: 'st-gen',
  code: 'GEN-SERV-01',
  name: 'General Servicing',
  baseDurationMinutes: 90,
  sedanDurationMinutes: 90,
  suvDurationMinutes: 120,
  requiresMileage: false,
};
/** A service that takes the same time on everything. */
const OIL = {
  id: 'st-oil',
  code: 'OIL-01',
  name: 'Oil Change',
  baseDurationMinutes: 30,
  sedanDurationMinutes: null,
  suvDurationMinutes: null,
  requiresMileage: false,
};
const CATALOGUE = [GEN_SERV, OIL];

type Cls = 'SEDAN_CLASS' | 'SUV_CLASS' | null;

/**
 * Honour the `select`, exactly as Prisma would.
 *
 * This is the mechanism that makes the Defect-A assertions real: a query that stops
 * naming the class columns gets rows without them, and the resolver's runtime guard
 * then throws instead of the test quietly passing on a fixture that over-supplies.
 */
function applySelect(rows: Record<string, unknown>[], select: Record<string, unknown> | undefined) {
  if (!select) return rows.map((r) => ({ ...r }));
  const keys = Object.keys(select).filter((k) => select[k]);
  return rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
}

// ---------------------------------------------------------------------------
// Service orders
// ---------------------------------------------------------------------------

function buildOrders(serviceClass: Cls) {
  const created: any[] = [];
  const itemsCreatedMany: any[] = [];

  const tx: any = {
    serviceOrder: {
      create: vi.fn(async ({ data }: any) => {
        created.push(data);
        return { id: 'so-1', ...data, items: [], serviceVisit: {}, assignments: [] };
      }),
      update: vi.fn(async () => ({ id: 'so-1', items: [], assignments: [], serviceVisit: {} })),
    },
    serviceOrderItem: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      createMany: vi.fn(async ({ data }: any) => { itemsCreatedMany.push(...data); return { count: data.length }; }),
    },
  };

  const prisma: any = {
    serviceVisit: {
      findUnique: vi.fn(async () => ({
        id: 'sv-1',
        siteId: 'site-1',
        status: 'CHECKED_IN',
        vehicle: { serviceClass },
      })),
    },
    serviceType: {
      findMany: vi.fn(async ({ where, select }: any) => {
        const wanted: string[] = where?.code?.in ?? [];
        return applySelect(CATALOGUE.filter((s) => wanted.includes(s.code)), select);
      }),
    },
    serviceOrder: {
      findUnique: vi.fn(async () => ({
        id: 'so-1',
        status: 'DRAFT',
        serviceVisitId: 'sv-1',
        items: [],
        assignments: [],
        serviceVisit: { id: 'sv-1', siteId: 'site-1' },
      })),
    },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };

  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  // The scheduling/KPI/segment collaborators play no part in estimating a line, so
  // they are inert stubs rather than mocks with expectations.
  const scheduling = { recomputeQueue: vi.fn(async () => undefined) };
  const kpi = { snapshotForOrder: vi.fn(async () => null) };
  const segments = { open: vi.fn(async () => null) };
  const service = new ServiceOrdersService(
    prisma,
    statusHistory as any,
    audit as any,
    scheduling as any,
    kpi as any,
    segments as any,
  );
  return { service, prisma, tx, created, itemsCreatedMany };
}

/** The estimate written for a newly created order line. */
async function orderEstimate(serviceClass: Cls, code = 'GEN-SERV-01', explicit?: number): Promise<number> {
  const h = buildOrders(serviceClass);
  await h.service.create(
    { serviceVisitId: 'sv-1', items: [{ serviceTypeCode: code, ...(explicit ? { estimateMinutes: explicit } : {}) }] } as any,
    'user-1',
  );
  return h.created[0].items.create[0].estimateMinutes;
}

/** The estimate written when the lines of an existing order are replaced. */
async function editedOrderEstimate(serviceClass: Cls, code = 'GEN-SERV-01'): Promise<number> {
  const h = buildOrders(serviceClass);
  await h.service.updateOrder('so-1', { items: [{ serviceTypeCode: code }] }, 'user-1');
  return h.itemsCreatedMany[0].estimateMinutes;
}

describe('§6 Service Order — General Servicing line estimate', () => {
  it('Sedan → 90', async () => {
    expect(await orderEstimate('SEDAN_CLASS')).toBe(90);
  });

  it('SUV → 120', async () => {
    expect(await orderEstimate('SUV_CLASS')).toBe(120);
  });

  /** §3 — the existing UNKNOWN_ASSUMED_LONGEST behaviour, unchanged. */
  it('unknown class → 120, never the shorter standard', async () => {
    expect(await orderEstimate(null)).toBe(120);
  });

  it('a non-class-specific service keeps its catalogue duration for every vehicle', async () => {
    for (const cls of ['SEDAN_CLASS', 'SUV_CLASS', null] as Cls[]) {
      expect(await orderEstimate(cls, 'OIL-01'), String(cls)).toBe(30);
    }
  });

  /**
   * An advisor looking at the car outranks the catalogue. The resolver supplies the
   * DEFAULT, not a ceiling.
   */
  it("an advisor's explicit estimate still wins", async () => {
    expect(await orderEstimate('SUV_CLASS', 'GEN-SERV-01', 150)).toBe(150);
  });

  it('loads the class columns from the database', async () => {
    const h = buildOrders('SUV_CLASS');
    await h.service.create({ serviceVisitId: 'sv-1', items: [{ serviceTypeCode: 'GEN-SERV-01' }] } as any, 'user-1');
    expect((h.prisma.serviceType.findMany.mock.calls as any[])[0][0].select).toMatchObject({
      sedanDurationMinutes: true,
      suvDurationMinutes: true,
    });
  });
});

describe('§2 editing an order does not lose the class duration', () => {
  it('Sedan → 90, SUV → 120, unknown → 120', async () => {
    expect(await editedOrderEstimate('SEDAN_CLASS')).toBe(90);
    expect(await editedOrderEstimate('SUV_CLASS')).toBe(120);
    expect(await editedOrderEstimate(null)).toBe(120);
  });

  it('creating and then editing an SUV order give the same estimate', async () => {
    expect(await editedOrderEstimate('SUV_CLASS')).toBe(await orderEstimate('SUV_CLASS'));
  });

  /** No pointless query when no service on the order varies by class. */
  it('does not look up the vehicle when the class cannot change the answer', async () => {
    const h = buildOrders('SUV_CLASS');
    await h.service.updateOrder('so-1', { items: [{ serviceTypeCode: 'OIL-01' }] }, 'user-1');
    expect(h.prisma.serviceVisit.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Walk-ins
// ---------------------------------------------------------------------------

function buildWalkIn(serviceClass: Cls) {
  const orderCreated: any[] = [];
  const tx: any = {
    serviceVisit: {
      create: vi.fn(async ({ data }: any) => ({ id: 'sv1', ...data, customer: {}, vehicle: {} })),
      update: vi.fn(async () => ({ id: 'sv1' })),
    },
    serviceOrder: {
      create: vi.fn(async ({ data }: any) => {
        orderCreated.push(data);
        return { id: 'so1', ...data, items: [] };
      }),
    },
    queueTicket: { create: vi.fn(async ({ data }: any) => ({ id: 'qt1', ticketNumber: 'A001', ...data })) },
    vehicle: { update: vi.fn(async () => ({})) },
    customer: { update: vi.fn(async () => ({})) },
    vehicleClassification: { upsert: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => [{ next_val: 1 }]),
    $executeRaw: vi.fn(async () => 1),
  };

  const prisma: any = {
    site: { findUnique: vi.fn(async () => ({ id: 'site-1', code: 'BERT-01', timezone: 'America/Jamaica', isActive: true, ticketCode: 'B01' })) },
    customer: {
      findUnique: vi.fn(async () => ({
        id: 'c1', firstName: 'Jane', lastName: 'Doe', phone: '876-555-0100',
        notificationOptInSms: false, notificationOptInEmail: false,
      })),
    },
    vehicle: {
      findUnique: vi.fn(async ({ select }: any) =>
        applySelect(
          [{ id: 'v1', customerId: 'c1', plateNumber: 'ABC1234', make: 'Toyota', model: 'RAV4', modelYear: 2021, serviceClass }],
          select,
        )[0],
      ),
    },
    serviceType: {
      findMany: vi.fn(async ({ where, select }: any) => {
        const wanted: string[] = where?.code?.in ?? [];
        return applySelect(CATALOGUE.filter((s) => wanted.includes(s.code)), select);
      }),
    },
    serviceVisit: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    queueTicket: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };

  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new WalkInsService(prisma, statusHistory as any, audit as any);
  return { service, prisma, tx, orderCreated };
}

/** The estimate written for a walk-in's order line. */
async function walkInEstimate(serviceClass: Cls, code = 'GEN-SERV-01'): Promise<number> {
  const h = buildWalkIn(serviceClass);
  try {
    await h.service.register(
      { siteId: 'site-1', customerId: 'c1', vehicleId: 'v1', serviceTypes: [{ serviceTypeCode: code }] } as any,
      'user-1',
    );
  } catch {
    /* later stages (queue ranking, ETA) are out of scope for this assertion */
  }
  return h.orderCreated[0].items.create[0].estimateMinutes;
}

describe('§3 Walk-in — a walk-in is not a separate duration policy', () => {
  it('Sedan General Servicing → 90', async () => {
    expect(await walkInEstimate('SEDAN_CLASS')).toBe(90);
  });

  it('SUV General Servicing → 120', async () => {
    expect(await walkInEstimate('SUV_CLASS')).toBe(120);
  });

  it('unknown class → 120, under the existing longest-duration rule', async () => {
    expect(await walkInEstimate(null)).toBe(120);
  });

  it('a non-class-specific service keeps its catalogue duration', async () => {
    for (const cls of ['SEDAN_CLASS', 'SUV_CLASS', null] as Cls[]) {
      expect(await walkInEstimate(cls, 'OIL-01'), String(cls)).toBe(30);
    }
  });

  it('loads the class columns, and the vehicle class, from the database', async () => {
    const h = buildWalkIn('SUV_CLASS');
    try {
      await h.service.register(
        { siteId: 'site-1', customerId: 'c1', vehicleId: 'v1', serviceTypes: [{ serviceTypeCode: 'GEN-SERV-01' }] } as any,
        'user-1',
      );
    } catch { /* out of scope */ }
    expect((h.prisma.serviceType.findMany.mock.calls as any[])[0][0].select).toMatchObject({
      sedanDurationMinutes: true,
      suvDurationMinutes: true,
    });
    expect((h.prisma.vehicle.findUnique.mock.calls as any[])[0][0].select).toMatchObject({ serviceClass: true });
  });
});

// ---------------------------------------------------------------------------
// The three channels agree
// ---------------------------------------------------------------------------

describe('§ acceptance — order lines and walk-ins agree with each other', () => {
  it('a walk-in and a staff-raised order estimate the same work identically', async () => {
    for (const cls of ['SEDAN_CLASS', 'SUV_CLASS', null] as Cls[]) {
      expect(await walkInEstimate(cls), `class ${cls}`).toBe(await orderEstimate(cls));
    }
  });

  it('the shared select is what both of them use', () => {
    for (const column of ['baseDurationMinutes', 'sedanDurationMinutes', 'suvDurationMinutes']) {
      expect(SERVICE_DURATION_SELECT, column).toHaveProperty(column, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Defect A, on these paths
// ---------------------------------------------------------------------------

describe('§6 a line cannot be estimated from a service loaded without its class columns', () => {
  it('the guard names the service rather than silently using the base duration', async () => {
    const h = buildOrders('SUV_CLASS');
    // Reproduce the defect: the query stops asking for the class columns, and the
    // select-aware fixture therefore returns rows without them.
    h.prisma.serviceType.findMany = vi.fn(async ({ where }: any) => {
      const wanted: string[] = where?.code?.in ?? [];
      return CATALOGUE.filter((s) => wanted.includes(s.code)).map((s) => ({
        id: s.id,
        code: s.code,
        baseDurationMinutes: s.baseDurationMinutes,
      })) as never;
    });
    await expect(
      h.service.create({ serviceVisitId: 'sv-1', items: [{ serviceTypeCode: 'GEN-SERV-01' }] } as any, 'user-1'),
    ).rejects.toThrow(/GEN-SERV-01 was loaded without its vehicle-class duration columns/);
  });

  it('a genuinely null class column is fine — it means "same time for every vehicle"', async () => {
    const svc: MeasurableService = { baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null };
    expect(svc.sedanDurationMinutes).toBeNull();
    expect(await orderEstimate('SUV_CLASS', 'OIL-01')).toBe(30);
  });
});
