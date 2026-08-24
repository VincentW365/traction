import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchService } from '../search.service';

/** CR-2026-097 — global record search routes each identifier to the right entity. */

function build() {
  const prisma: Record<string, { findMany: ReturnType<typeof vi.fn> }> = {
    customer: { findMany: vi.fn(async () => []) },
    vehicle: { findMany: vi.fn(async () => []) },
    serviceVisit: { findMany: vi.fn(async () => []) },
    vehicleInspection: { findMany: vi.fn(async () => []) },
  };
  return { service: new SearchService(prisma as never), prisma };
}

describe('SearchService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty for queries under 2 characters without touching the database', async () => {
    const { service, prisma } = build();
    const r = await service.search('a');
    expect(r.customers).toEqual([]);
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('finds a vehicle by licence plate with owner context', async () => {
    const { service, prisma } = build();
    prisma.vehicle.findMany.mockResolvedValue([{
      id: 'veh1', plateNumber: '1234 AB', vehicleCode: 'SC1', make: 'Honda', model: 'Grace', modelYear: 2019,
      customer: { id: 'c1', firstName: 'Vincent', lastName: 'Wilson' },
    }]);
    const r = await service.search('1234 AB');
    expect(r.vehicles[0]).toMatchObject({ label: '2019 Honda Grace', plateNumber: '1234 AB', owner: { name: 'Vincent Wilson' } });
    const where = (prisma.vehicle.findMany.mock.calls[0] as unknown as any[])[0].where;
    expect(where.OR.some((c: Record<string, unknown>) => 'plateNumber' in c)).toBe(true);
    expect(where.OR.some((c: Record<string, unknown>) => 'vin' in c)).toBe(true);
  });

  it('finds a visit by visit number', async () => {
    const { service, prisma } = build();
    prisma.serviceVisit.findMany.mockResolvedValue([{
      id: 'v1', visitNumber: 'V-231025-001', status: 'CLOSED',
      checkedInAt: new Date('2023-10-25'), arrivalAt: null, createdAt: new Date('2023-10-25'),
      customer: { firstName: 'Ann', lastName: 'Lee' },
      vehicle: { plateNumber: '5555 CD', make: 'Toyota', model: 'Corolla' },
    }]);
    const r = await service.search('V-231025-001');
    expect(r.visits[0]).toMatchObject({ id: 'v1', visitNumber: 'V-231025-001', customer: 'Ann Lee' });
  });

  it('resolves a job-sheet number (JS-<visit>) to the underlying visit', async () => {
    const { service, prisma } = build();
    await service.search('JS-B01-260820-003');
    const where = (prisma.serviceVisit.findMany.mock.calls[0] as unknown as any[])[0].where;
    // The JS- prefix is stripped before matching the visit number.
    expect(JSON.stringify(where)).toContain('B01-260820-003');
    expect(JSON.stringify(where)).not.toContain('JS-B01');
  });

  it('finds an inspection by number and carries its visit for navigation', async () => {
    const { service, prisma } = build();
    prisma.vehicleInspection.findMany.mockResolvedValue([{
      id: 'i1', inspectionNumber: 'INS-000007', kind: 'VEHICLE_INSPECTION', status: 'COMPLETED',
      createdAt: new Date(), serviceVisit: { id: 'v9', visitNumber: 'B01-260820-014' },
    }]);
    const r = await service.search('INS-000007');
    expect(r.inspections[0]).toMatchObject({ serviceVisitId: 'v9', visitNumber: 'B01-260820-014' });
  });

  it('searches customers by phone digits and by two-part name', async () => {
    const { service, prisma } = build();
    await service.search('876-555-1234');
    let where = (prisma.customer.findMany.mock.calls[0] as unknown as any[])[0].where;
    expect(JSON.stringify(where)).toContain('5551234'); // last-7-digit match

    await service.search('Vincent Wilson');
    where = (prisma.customer.findMany.mock.calls[1] as unknown as any[])[0].where;
    const and = where.OR.find((c: Record<string, unknown>) => 'AND' in c);
    expect(and).toBeDefined();
  });

  it('excludes test-tagged sandbox rows everywhere', async () => {
    const { service, prisma } = build();
    await service.search('anything');
    expect((prisma.customer.findMany.mock.calls[0] as unknown as any[])[0].where.testDataRunId).toBeNull();
    expect((prisma.serviceVisit.findMany.mock.calls[0] as unknown as any[])[0].where.testDataRunId).toBeNull();
  });
});
