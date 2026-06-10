import { describe, it, expect, vi } from 'vitest';
import { ReportingService } from '../reporting.service';

function build() {
  const prisma: any = {
    serviceVisit: {
      aggregate: vi.fn(async () => ({
        _min: { createdAt: new Date('2023-10-25T00:00:00Z') },
        _max: { createdAt: new Date('2026-06-09T00:00:00Z') },
      })),
      groupBy: vi.fn(async () => [
        { status: 'CLOSED', _count: { _all: 8971 } },
        { status: 'CANCELLED', _count: { _all: 84 } },
      ]),
    },
    serviceOrder: { count: vi.fn(async () => 9000) },
    serviceOrderPause: { findMany: vi.fn(async () => [{ serviceOrderId: 'a' }, { serviceOrderId: 'b' }]) },
    serviceOrderRework: { findMany: vi.fn(async () => [{ serviceOrderId: 'a' }]) },
    $queryRaw: vi.fn(),
  };
  // Promise.all order: aggregate, groupBy, count, pause, rework, $queryRaw(monthly), $queryRaw(tech), $queryRaw(duration)
  prisma.$queryRaw
    .mockResolvedValueOnce([{ month: new Date('2025-01-01T00:00:00Z'), jobs: 100 }]) // monthly
    .mockResolvedValueOnce([{ technicianId: 't1', name: 'O. Josephs', jobs: 500 }]) // tech
    .mockResolvedValueOnce([{ avg_minutes: 45, sample: 702 }]); // duration
  const service = new ReportingService(prisma);
  return { service, prisma };
}

describe('ReportingService.getHistoricalAnalytics', () => {
  it('aggregates HISTORICAL_IMPORT-only and returns headline/rates/trend/workload', async () => {
    const h = build();
    const out = await h.service.getHistoricalAnalytics();

    // historical-only scope on the Prisma queries
    expect(h.prisma.serviceVisit.aggregate.mock.calls[0][0].where).toEqual({ sourceType: 'HISTORICAL_IMPORT' });
    expect(h.prisma.serviceVisit.groupBy.mock.calls[0][0].where).toEqual({ sourceType: 'HISTORICAL_IMPORT' });

    expect(out.span).toEqual({ from: '2023-10-25', to: '2026-06-09' });
    expect(out.headline.totalJobs).toBe(9055);
    expect(out.headline.completed).toBe(8971);
    expect(out.headline.cancelled).toBe(84);
    expect(out.headline.completionRate).toBe(99.1); // round(8971/9055*1000)/10
    expect(out.headline.cancellationRate).toBe(0.9);

    expect(out.totalOrders).toBe(9000);
    expect(out.pauseRate).toBe(0); // 2/9000 -> round to 0.0
    expect(out.reworkRate).toBe(0);

    expect(out.avgDurationMinutes).toBe(45);
    expect(out.durationSampleSize).toBe(702);
    expect(out.monthlyVolume).toEqual([{ month: '2025-01', jobs: 100 }]);
    expect(out.byTechnician).toEqual([{ technicianId: 't1', name: 'O. Josephs', jobs: 500 }]);
  });

  it('applies a date window to the status/order queries when from/to given', async () => {
    const h = build();
    await h.service.getHistoricalAnalytics({ from: '2025-01-01', to: '2025-12-31' });
    const gbWhere = h.prisma.serviceVisit.groupBy.mock.calls[0][0].where;
    expect(gbWhere.sourceType).toBe('HISTORICAL_IMPORT');
    expect(gbWhere.createdAt.gte).toBeInstanceOf(Date);
    expect(gbWhere.createdAt.lte).toBeInstanceOf(Date);
    // span still reflects the full data range (aggregate ignores the window)
    expect(h.prisma.serviceVisit.aggregate.mock.calls[0][0].where).toEqual({ sourceType: 'HISTORICAL_IMPORT' });
  });
});
