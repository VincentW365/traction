import { describe, it, expect, vi } from 'vitest';
import { ReportingService } from '../reporting.service';

/**
 * CR-2026-019 (P1c) — Service Mix analytics. Mocked PrismaService.
 * getServiceMix issues 6 $queryRaw (in order: perJob, timeline, opRows, techRows,
 * coverage, live) plus serviceOrder.count + serviceVisit.aggregate.
 */
function build() {
  const prisma: any = {
    $queryRaw: vi.fn(),
    serviceOrder: { count: vi.fn(async () => 100) },
    serviceVisit: { aggregate: vi.fn(async () => ({ _min: { createdAt: new Date('2023-10-25') }, _max: { createdAt: new Date('2026-06-09') } })) },
  };
  prisma.$queryRaw
    .mockResolvedValueOnce([ // perJob: c1 has auto+review+price; c2 is ALL review + price
      { id: 'c1', name: 'Oil Change', category: 'SERVICE', base_price: 2000, auto_vol: 5, review_vol: 3 },
      { id: 'c2', name: 'Brake Job', category: 'BRAKES', base_price: 4000, auto_vol: 0, review_vol: 4 },
    ])
    .mockResolvedValueOnce([ // timeline
      { month: new Date('2026-04-01'), category: 'SERVICE', jobs: 10 },
      { month: new Date('2026-05-01'), category: 'SERVICE', jobs: 12 },
    ])
    .mockResolvedValueOnce([ // opRows
      { category: 'SERVICE', orders: 8, avg_minutes: 30, dur_sample: 5, completed: 8, cancelled: 0, paused: 2, reworked: 1 },
    ])
    .mockResolvedValueOnce([{ category: 'SERVICE', name: 'O. Josephs', jobs: 5 }]) // techRows
    .mockResolvedValueOnce([{ auto_orders: 5, any_orders: 9 }]) // coverage
    .mockResolvedValueOnce([]); // live (empty)
  return { service: new ReportingService(prisma as any), prisma };
}

describe('getServiceMix (P1c)', () => {
  it('AUTO_MATCHED revenue is included; NEEDS_REVIEW revenue is excluded', async () => {
    const r: any = await build().service.getServiceMix({ mode: 'auto' });
    const svc = r.historical.categorySummary.find((c: any) => c.category === 'SERVICE');
    const brk = r.historical.categorySummary.find((c: any) => c.category === 'BRAKES');
    expect(svc.estValueAuto).toBe(10000); // 5 auto × 2000
    expect(brk.estValueAuto).toBe(0); // all NEEDS_REVIEW → no estimated revenue
    expect(r.valueNote).toMatch(/estimated catalog value/i);
  });

  it('auto mode excludes NEEDS_REVIEW from volume', async () => {
    const r: any = await build().service.getServiceMix({ mode: 'auto' });
    const svc = r.historical.categorySummary.find((c: any) => c.category === 'SERVICE');
    expect(svc.jobs).toBe(5); // auto only
    expect(svc.auto).toBe(5); expect(svc.review).toBe(3);
  });

  it('suggested mode includes NEEDS_REVIEW in volume but NOT in revenue', async () => {
    const r: any = await build().service.getServiceMix({ mode: 'suggested' });
    const svc = r.historical.categorySummary.find((c: any) => c.category === 'SERVICE');
    expect(svc.jobs).toBe(8); // 5 auto + 3 review
    expect(svc.estValueAuto).toBe(10000); // revenue still auto-only
  });

  it('reports unmapped coverage', async () => {
    const r: any = await build().service.getServiceMix({});
    expect(r.historical.coverage).toMatchObject({
      totalHistoricalOrders: 100, autoMappedOrders: 5, anyMappedOrders: 9, unmappedOrders: 91,
      analyticsReadyPct: 5, potentialAfterReviewPct: 9, unmappedPct: 91,
    });
    expect(r.live.hasLiveItems).toBe(false); // empty live → empty-state flag
  });

  it('exposes no raw notes/comments/rawText in the payload', async () => {
    const r: any = await build().service.getServiceMix({ mode: 'suggested' });
    const json = JSON.stringify(r);
    expect(json).not.toContain('rawText');
    expect(json).not.toContain('"notes"');
    expect(json).not.toContain('"comment"');
  });
});
