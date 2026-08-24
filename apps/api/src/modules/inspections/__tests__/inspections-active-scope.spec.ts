import { describe, it, expect, vi } from 'vitest';
import { InspectionsService } from '../inspections.service';

/**
 * CR-2026-097 — active-queue hygiene + technician-scope composition.
 *
 * 1. A completed VISIT leaves the active inspection worklist even when its
 *    inspection was left in DRAFT — status/filtering, never deletion.
 * 2. The technician scope must survive a free-text search: both are OR-fragments,
 *    and composing them with Object.assign let the search overwrite the scope.
 */

function build() {
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const prisma: any = { vehicleInspection: { findMany, count } };
  const service = new InspectionsService(prisma, {} as any, {} as any, {} as any);
  return { service, findMany };
}

const ADMIN = { sub: 'u1', role: 'ADMIN', siteId: 'site1' } as any;
const TECH = { sub: 'u-tech', role: 'TECHNICIAN', siteId: 'site1' } as any;

describe('list — active worklist', () => {
  it('active excludes inspections whose visit is CLOSED/ABANDONED/CANCELLED', async () => {
    const { service, findMany } = build();
    await service.list({ active: true, siteId: 'site1' } as any, ADMIN);
    const where = (findMany.mock.calls[0] as unknown as any[])[0].where;
    expect(where.status).toEqual({ in: ['DRAFT', 'COMPLETED', 'SIGNED_OFF'] });
    expect(where.serviceVisit).toEqual({ status: { notIn: ['CLOSED', 'ABANDONED', 'CANCELLED'] } });
  });

  it('an explicit status filter does NOT hide closed-visit records (history stays reachable)', async () => {
    const { service, findMany } = build();
    await service.list({ status: 'CLOSED', siteId: 'site1' } as any, ADMIN);
    const where = (findMany.mock.calls[0] as unknown as any[])[0].where;
    expect(where.serviceVisit).toBeUndefined();
  });

  it('the search box also matches the visit number', async () => {
    const { service, findMany } = build();
    await service.list({ q: 'B01-260824', siteId: 'site1' } as any, ADMIN);
    const where = (findMany.mock.calls[0] as unknown as any[])[0].where;
    expect(where.OR.some((c: any) => c.serviceVisit?.visitNumber)).toBe(true);
  });
});

describe('list — technician scope composition', () => {
  it('keeps the technician scope in force when a free-text search is used', async () => {
    const { service, findMany } = build();
    await service.list({ q: 'anything' } as any, TECH);
    const where = (findMany.mock.calls[0] as unknown as any[])[0].where;
    // Scope survives as an AND-fragment; the search OR does not replace it.
    expect(where.AND).toBeDefined();
    const scope = where.AND[0];
    expect(scope.OR.some((c: any) => c.performedByUserId === 'u-tech')).toBe(true);
    expect(where.OR.some((c: any) => c.inspectionNumber)).toBe(true);
  });
});
