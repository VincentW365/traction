import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VehiclesService } from '../vehicles.service';
import { PLACEHOLDER_VEHICLE_CODE_PREFIX } from '../../../common/helpers/operational-scope';

/**
 * CR-2026-006 — vehicle search and by-customer lists exclude placeholder
 * vehicles (vehicleCode starts 'HIST-UNRESOLVED-') by default; includeHistorical
 * removes the filter.
 *
 * CR-2026-020 — the live filter now ALSO excludes test-data vehicles by default
 * (`testDataRunId: null`); a no-op until a test run exists.
 */
function buildService() {
  const prisma: any = {
    vehicle: { findMany: vi.fn(async () => []) },
    customer: { findUnique: vi.fn(async () => ({ id: 'cust-1' })) },
  };
  return { service: new VehiclesService(prisma as any, { autoClassify: async () => ({ applied: false }) } as any), prisma };
}

const liveVehicle = { vehicleCode: { not: { startsWith: PLACEHOLDER_VEHICLE_CODE_PREFIX } }, testDataRunId: null };

describe('VehiclesService operational scope (CR-2026-006)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('search excludes placeholder vehicles by default (AND-wrapped)', async () => {
    await h.service.search('ABC');
    const where = h.prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where.AND[where.AND.length - 1]).toEqual(liveVehicle);
  });

  it('search includeHistorical=true removes the historical filter (test-data filter remains)', async () => {
    await h.service.search('ABC', true);
    const where = h.prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where.AND[where.AND.length - 1]).toEqual({ testDataRunId: null });
  });

  it('findByCustomer excludes placeholder vehicles by default', async () => {
    await h.service.findByCustomer('cust-1');
    const where = h.prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where.vehicleCode).toEqual(liveVehicle.vehicleCode);
  });

  it('findByCustomer includeHistorical=true removes the filter', async () => {
    await h.service.findByCustomer('cust-1', true);
    const where = h.prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where.vehicleCode).toBeUndefined();
  });
});
