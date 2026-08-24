import { describe, it, expect, vi } from 'vitest';
import { CustomersService } from '../customers.service';

/**
 * CR-2026-030 — getServiceHistory derives a customer's full paginated history
 * from ServiceVisit: INCLUDES historical-import visits (real history + mileage
 * pattern source), EXCLUDES test-data sandbox rows, ordered newest-first.
 */
function build(rows: unknown[] = [], total = 0) {
  const prisma: any = {
    serviceVisit: {
      findMany: vi.fn(async () => rows),
      count: vi.fn(async () => total),
    },
  };
  return { service: new CustomersService(prisma as any), prisma };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  status: 'CLOSED',
  sourceType: 'WALKIN',
  checkedInAt: new Date('2026-01-02'),
  arrivalAt: null,
  createdAt: new Date('2026-01-01'),
  mileageIn: 50000,
  mileageOut: 50250,
  vehicle: { id: 'veh1', vehicleCode: 'SCABC', plateNumber: 'ABC123', make: 'Toyota', model: 'Camry', modelYear: 2020 },
  appointment: { services: [{ serviceType: { name: 'Oil Change' } }] },
  serviceOrders: [{ items: [{ serviceType: { name: 'Oil Change' } }, { serviceType: { name: 'Tire Rotation' } }] }],
  // CR-2026-097 — availability flags now included per row.
  inspections: [],
  jobSheetDraft: null,
  ...over,
});

describe('CustomersService.getServiceHistory (CR-2026-030)', () => {
  it('queries by customer, includes historical, excludes test data, ordered desc, default page', async () => {
    const { service, prisma } = build([], 0);
    await service.getServiceHistory('cust-1');
    const args = prisma.serviceVisit.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ customerId: 'cust-1', testDataRunId: null });
    expect(args.where.sourceType).toBeUndefined(); // historical NOT filtered out
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.take).toBe(20);
    expect(args.skip).toBe(0);
    expect(prisma.serviceVisit.count.mock.calls[0][0].where).toEqual({ customerId: 'cust-1', testDataRunId: null });
  });

  it('clamps limit to 1..100 and offset to >= 0', async () => {
    const { service, prisma } = build([], 0);
    await service.getServiceHistory('c', { limit: 999, offset: -5 });
    let args = prisma.serviceVisit.findMany.mock.calls[0][0];
    expect(args.take).toBe(100);
    expect(args.skip).toBe(0);

    const r2 = await service.getServiceHistory('c', { limit: 0, offset: 5 });
    args = prisma.serviceVisit.findMany.mock.calls[1][0];
    expect(args.take).toBe(1);
    expect(args.skip).toBe(5);
    expect(r2.limit).toBe(1);
    expect(r2.offset).toBe(5);
  });

  it('maps deduped services, visitedAt (checkedInAt wins), vehicle label, paginated shape', async () => {
    const { service } = build([row()], 1);
    const res = await service.getServiceHistory('c', { limit: 10, offset: 0 });
    expect(res.total).toBe(1);
    expect(res.limit).toBe(10);
    expect(res.items).toHaveLength(1);
    const it0 = res.items[0];
    expect(it0.services).toEqual(['Oil Change', 'Tire Rotation']); // deduped across appointment + orders
    expect(it0.visitedAt).toEqual(new Date('2026-01-02'));
    expect(it0.vehicle).toEqual({ id: 'veh1', vehicleCode: 'SCABC', plateNumber: 'ABC123', label: '2020 Toyota Camry' });
    expect(it0.mileageIn).toBe(50000);
    expect(it0.mileageOut).toBe(50250);
  });

  it('falls back visitedAt to arrivalAt then createdAt; handles null vehicle + no services', async () => {
    const { service } = build(
      [row({ checkedInAt: null, arrivalAt: new Date('2026-02-02'), vehicle: null, appointment: null, serviceOrders: [] })],
      1,
    );
    const res = await service.getServiceHistory('c');
    expect(res.items[0].visitedAt).toEqual(new Date('2026-02-02'));
    expect(res.items[0].vehicle).toBeNull();
    expect(res.items[0].services).toEqual([]);
  });
});
