import { describe, it, expect, vi } from 'vitest';
import { InspectionsService } from '../inspections.service';

/**
 * CR-2026-081 — inspection lifecycle timestamps (completedAt/closedAt) and the
 * extended list (active/history split, per-customer archive, date range, search,
 * severity, findings summary + fallback inspection date). Pure mocks; no DB.
 */

const STAFF = { sub: 'u1', siteId: 'site1', role: 'SERVICE_ADVISOR' };

function buildForTransitions() {
  const tx: any = {
    vehicleInspection: { updateMany: vi.fn(async () => ({ count: 1 })) },
    inspectionSignature: { create: vi.fn(async () => ({})) },
  };
  const prisma: any = {
    vehicleInspection: {
      findUnique: vi.fn(async () => ({ id: 'i1', siteId: 'site1', status: 'DRAFT', items: [], wheelMeasurements: [], recommendations: [], signatures: [], customer: null, vehicle: null, serviceVisit: null })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const audit = { log: vi.fn(async () => ({})) };
  const statusHistory = { record: vi.fn(async () => ({})), findByEntity: vi.fn(async () => []) };
  const serviceOrders = { create: vi.fn() };
  const service = new InspectionsService(prisma as any, audit as any, statusHistory as any, serviceOrders as any);
  return { service, prisma, tx };
}

function buildForList(rows: any[] = [], total = rows.length) {
  const findMany = vi.fn(async () => rows);
  const count = vi.fn(async () => total);
  const prisma: any = { vehicleInspection: { findMany, count } };
  const service = new InspectionsService(prisma as any, {} as any, {} as any, {} as any);
  return { service, findMany, count };
}

describe('InspectionsService.complete/customerSignoff — lifecycle stamps (CR-2026-081)', () => {
  it('complete() stamps completedAt on the DRAFT→COMPLETED transition', async () => {
    const h = buildForTransitions();
    await h.service.complete('i1', STAFF as any);
    const data = (h.prisma.vehicleInspection.updateMany.mock.calls as any[])[0][0].data;
    expect(data.status).toBe('COMPLETED');
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('customerSignoff() stamps closedAt on the SIGNED_OFF→CLOSED transition', async () => {
    const h = buildForTransitions();
    await h.service.customerSignoff('i1', STAFF as any, { type: 'TYPED', typedName: 'A. Customer' } as any);
    const data = (h.tx.vehicleInspection.updateMany.mock.calls as any[])[0][0].data;
    expect(data.status).toBe('CLOSED');
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data.customerAckAt).toBeInstanceOf(Date);
  });
});

describe('InspectionsService.list — filters & shape (CR-2026-081)', () => {
  const whereOf = (h: ReturnType<typeof buildForList>) => (h.findMany.mock.calls as any[])[0][0].where;

  it('filters by customerId', async () => {
    const h = buildForList();
    await h.service.list({ customerId: 'cust1' } as any, STAFF as any);
    expect(whereOf(h)).toMatchObject({ siteId: 'site1', customerId: 'cust1' });
  });

  it('active=true narrows to the work-still-needed statuses', async () => {
    const h = buildForList();
    await h.service.list({ active: true } as any, STAFF as any);
    expect(whereOf(h).status).toEqual({ in: ['DRAFT', 'COMPLETED', 'SIGNED_OFF'] });
  });

  it('explicit status wins over active', async () => {
    const h = buildForList();
    await h.service.list({ active: true, status: 'CLOSED' } as any, STAFF as any);
    expect(whereOf(h).status).toBe('CLOSED');
  });

  it('applies an inclusive date range on createdAt', async () => {
    const h = buildForList();
    await h.service.list({ dateFrom: '2026-07-01', dateTo: '2026-07-07' } as any, STAFF as any);
    const created = whereOf(h).createdAt;
    expect(created.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(created.lte.toISOString()).toBe('2026-07-07T23:59:59.999Z');
  });

  it('builds an OR search over inspection #, customer name and plate', async () => {
    const h = buildForList();
    await h.service.list({ q: 'abc' } as any, STAFF as any);
    const or = whereOf(h).OR;
    expect(or).toHaveLength(4);
    expect(JSON.stringify(or)).toContain('inspectionNumber');
    expect(JSON.stringify(or)).toContain('plateNumber');
  });

  it('filters by finding severity', async () => {
    const h = buildForList();
    await h.service.list({ severity: 'IMMEDIATE' } as any, STAFF as any);
    expect(whereOf(h).recommendations).toEqual({ some: { severity: 'IMMEDIATE' } });
  });

  it('returns findings counts and a fallback inspection date', async () => {
    const rows = [
      {
        id: 'i1', inspectionNumber: 'INS-000001', status: 'COMPLETED',
        createdAt: new Date('2026-07-01T10:00:00Z'),
        completedAt: new Date('2026-07-02T10:00:00Z'),
        signedOffAt: null, closedAt: null, customerAckAt: null,
        customer: { id: 'c1', firstName: 'Jane', lastName: 'Doe' },
        vehicle: { id: 'v1', plateNumber: 'ABC123', make: 'Toyota', model: 'Corolla' },
        serviceVisit: { id: 'sv1' },
        recommendations: [{ severity: 'IMMEDIATE' }, { severity: 'IMMEDIATE' }, { severity: 'FUTURE' }],
      },
      {
        // historical row with no completedAt → falls back to createdAt
        id: 'i2', inspectionNumber: 'INS-000002', status: 'CLOSED',
        createdAt: new Date('2026-06-01T09:00:00Z'),
        completedAt: null, signedOffAt: null, closedAt: null, customerAckAt: null,
        customer: null, vehicle: null, serviceVisit: null,
        recommendations: [],
      },
    ];
    const h = buildForList(rows);
    const res: any = await h.service.list({} as any, STAFF as any);
    expect(res.items[0].findings).toEqual({ immediate: 2, future: 1, total: 3 });
    expect(res.items[0].inspectionDate).toEqual(new Date('2026-07-02T10:00:00Z')); // completedAt
    expect(res.items[1].inspectionDate).toEqual(new Date('2026-06-01T09:00:00Z')); // fallback createdAt
    expect(res.items[0]).not.toHaveProperty('recommendations'); // raw dropped
    expect(res.total).toBe(2);
  });
});
