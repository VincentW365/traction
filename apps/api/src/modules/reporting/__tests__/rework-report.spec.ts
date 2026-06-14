import { describe, it, expect, vi } from 'vitest';
import { ReportingService } from '../reporting.service';
import { HISTORICAL_VISIT_SOURCE_TYPE } from '../../../common/helpers/operational-scope';

/**
 * CR-2026-031 — Rework / First-Time-Fix report. LIVE scope (excludes
 * HISTORICAL_IMPORT + test data), reworkRate = reworked/total,
 * firstTimeFixRate = 100 - reworkRate, plus the rework ledger mapping.
 */
function build({ total = 0, distinct = [] as unknown[], detailed = [] as unknown[] } = {}) {
  const prisma: any = {
    serviceOrder: { count: vi.fn(async () => total) },
    serviceOrderRework: {
      findMany: vi.fn().mockResolvedValueOnce(distinct).mockResolvedValueOnce(detailed),
    },
  };
  return { service: new ReportingService(prisma as any), prisma };
}

const detailedRow = (over: Record<string, unknown> = {}) => ({
  id: 'rw1',
  serviceOrderId: 'so1',
  reasonCode: 'QC_FAIL',
  description: 'Oil leak after service',
  reworkCount: 1,
  openedAt: new Date('2026-03-01T10:00:00.000Z'),
  closedAt: null,
  serviceOrder: {
    id: 'so1',
    serviceVisit: {
      customer: { firstName: 'Jane', lastName: 'Doe' },
      vehicle: { plateNumber: 'ABC123' },
    },
    assignments: [{ technician: { userAccount: { fullName: 'Tech Tom' } } }],
  },
  ...over,
});

describe('ReportingService.getReworkReport (CR-2026-031)', () => {
  it('scopes to live orders (excludes historical + test data) with no site/date by default', async () => {
    const { service, prisma } = build();
    await service.getReworkReport();
    const countWhere = prisma.serviceOrder.count.mock.calls[0][0].where;
    expect(countWhere.serviceVisit.sourceType).toEqual({ not: HISTORICAL_VISIT_SOURCE_TYPE });
    expect(countWhere.serviceVisit.testDataRunId).toBeNull();
    expect(countWhere.serviceVisit.siteId).toBeUndefined();
    expect(countWhere.serviceVisit.createdAt).toBeUndefined();
    // distinct rework query carries the same live visit filter
    const distinctWhere = prisma.serviceOrderRework.findMany.mock.calls[0][0].where;
    expect(distinctWhere.serviceOrder.serviceVisit.sourceType).toEqual({ not: HISTORICAL_VISIT_SOURCE_TYPE });
  });

  it('applies siteId + date window when provided', async () => {
    const { service, prisma } = build();
    await service.getReworkReport({ siteId: 'site-1', from: '2026-03-01', to: '2026-03-31' });
    const w = prisma.serviceOrder.count.mock.calls[0][0].where.serviceVisit;
    expect(w.siteId).toBe('site-1');
    expect(w.createdAt.gte).toEqual(new Date('2026-03-01'));
    expect(w.createdAt.lte.getHours()).toBe(23); // end-of-day
  });

  it('computes reworkRate + firstTimeFixRate from distinct reworked / total', async () => {
    const { service } = build({ total: 10, distinct: [{ serviceOrderId: 'a' }, { serviceOrderId: 'b' }] });
    const res = await service.getReworkReport();
    expect(res.summary.totalOrders).toBe(10);
    expect(res.summary.reworkedOrders).toBe(2);
    expect(res.summary.reworkRate).toBe(20);
    expect(res.summary.firstTimeFixRate).toBe(80);
  });

  it('returns zeroed rates when there are no orders', async () => {
    const { service } = build({ total: 0 });
    const res = await service.getReworkReport();
    expect(res.summary.reworkRate).toBe(0);
    expect(res.summary.firstTimeFixRate).toBe(0);
  });

  it('maps the rework ledger (reason, customer, vehicle, primary tech, count)', async () => {
    const { service } = build({ total: 5, distinct: [{ serviceOrderId: 'so1' }], detailed: [detailedRow()] });
    const res = await service.getReworkReport();
    expect(res.items).toHaveLength(1);
    const it0 = res.items[0];
    expect(it0.reasonCode).toBe('QC_FAIL');
    expect(it0.customerName).toBe('Jane Doe');
    expect(it0.vehiclePlate).toBe('ABC123');
    expect(it0.primaryTechnician).toBe('Tech Tom');
    expect(it0.reworkCount).toBe(1);
    expect(it0.openedAt).toBe('2026-03-01T10:00:00.000Z');
    expect(it0.closedAt).toBeNull();
  });
});
