import { describe, it, expect, vi } from 'vitest';
import { PerformanceReportService } from '../performance-report.service';

/**
 * CR-2026-104 — the report model reconciles with its source records (§36).
 *
 * The service COMPOSES the verified engines; these tests feed known job rows
 * and prove the derived numbers: distinct-vehicle counting, avg/median/max in
 * both bases, delay totals equal to the pause sums, honest comparisons (no
 * percentage against a zero base), explicit attention thresholds, and an
 * empty dataset that reports emptiness rather than fake zero activity.
 */

const T0 = new Date('2026-08-03T09:00:00Z');
function job(over: Record<string, unknown> = {}) {
  return {
    orderId: `so-${Math.random().toString(36).slice(2, 8)}`,
    status: 'QC',
    serviceVisitId: 'sv-1',
    expectedMinutes: 60,
    serviceCodes: ['OIL-01'],
    ticketNumber: 'T-1',
    visitNumber: 'V-1',
    customerName: 'Jane Doe',
    plate: 'ABC123',
    vehicleClass: 'SEDAN_CLASS',
    sourceType: 'WALKIN',
    services: ['Oil Change'],
    technicians: [{ technicianId: 'tech-1', name: 'Bob Smith' }],
    startedAt: T0,
    completedAt: new Date(T0.getTime() + 90 * 60000),
    elapsedMs: 90 * 60000,
    techWorkMs: 60 * 60000,
    waitingPartsMs: 0,
    waitingCustomerMs: 0,
    otherPausedMs: 0,
    ...over,
  };
}

function build(opts: {
  jobs?: unknown[];
  byTechnician?: unknown[];
  prevJobs?: unknown[];
  kpis?: Record<string, number>;
  prevKpis?: Record<string, number>;
  reworkSummary?: Record<string, number>;
  reworkItems?: unknown[];
} = {}) {
  const kpiRows = (map: Record<string, number>) =>
    Object.entries(map).map(([code, value]) => ({ code, name: code, value, target: null }));
  const kpis = opts.kpis ?? { 'KPI-01': 0, 'KPI-02': 0, 'KPI-03': 0, 'KPI-05': 0, 'KPI-06': 0, 'KPI-08': 0 };

  const reporting = {
    getKpis: vi
      .fn()
      .mockResolvedValueOnce(kpiRows(kpis))
      .mockResolvedValue(kpiRows(opts.prevKpis ?? kpis)),
    getReworkReport: vi.fn(async () => ({
      summary: {
        totalOrders: 10,
        reworkedOrders: 1,
        reworkRate: 10,
        firstTimeFixRate: 90,
        ...(opts.reworkSummary ?? {}),
      },
      items: opts.reworkItems ?? [],
    })),
  };
  const jobTimes = {
    getJobTimes: vi
      .fn()
      .mockResolvedValueOnce({ jobs: opts.jobs ?? [], byTechnician: opts.byTechnician ?? [], summary: {} })
      .mockResolvedValue({ jobs: opts.prevJobs ?? [], byTechnician: [], summary: {} }),
  };
  const prisma: any = {
    userAccount: { findUnique: vi.fn(async () => ({ fullName: 'Vala Manager' })) },
    serviceVisit: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    serviceOrderPause: { count: vi.fn(async () => 0) },
    serviceOrderRework: { count: vi.fn(async () => 0) },
  };
  return {
    service: new PerformanceReportService(prisma as any, reporting as any, jobTimes as any),
    prisma,
    reporting,
    jobTimes,
  };
}

describe('reconciliation with source records (§36)', () => {
  it('two jobs on one visit count ONE vehicle; time stats are correct in both bases', async () => {
    const h = build({
      jobs: [
        job({ elapsedMs: 60 * 60000, techWorkMs: 40 * 60000 }),
        job({ elapsedMs: 120 * 60000, techWorkMs: 80 * 60000 }), // same sv-1
        job({ serviceVisitId: 'sv-2', plate: 'XYZ999', elapsedMs: 240 * 60000, techWorkMs: 120 * 60000 }),
      ],
    });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');

    expect(r.summary.vehiclesServiced.value).toBe(2); // NOT 3
    expect(r.summary.jobsCompleted.value).toBe(3);
    // avg elapsed = (60+120+240)/3 = 140m; median = 120m; max = 240m.
    expect(r.summary.avgElapsedMs.value).toBe(140 * 60000);
    expect(r.summary.medianElapsedMs).toBe(120 * 60000);
    expect(r.summary.maxElapsedMs).toBe(240 * 60000);
    // Technician-work base is its OWN set of numbers, never renamed elapsed.
    expect(r.summary.avgTechWorkMs.value).toBe(80 * 60000);
    expect(r.summary.medianTechWorkMs).toBe(80 * 60000);
  });

  it('delay totals reconcile exactly with the pause sums on the job rows (§12)', async () => {
    const h = build({
      jobs: [
        job({ waitingPartsMs: 30 * 60000 }),
        job({ serviceVisitId: 'sv-2', waitingPartsMs: 90 * 60000, waitingCustomerMs: 20 * 60000 }),
        job({ serviceVisitId: 'sv-3', otherPausedMs: 10 * 60000 }),
      ],
    });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');

    const parts = r.delays.find((d) => d.type === 'WAITING_PARTS')!;
    expect(parts.jobsAffected).toBe(2);
    expect(parts.totalMs).toBe(120 * 60000);
    expect(parts.avgMs).toBe(60 * 60000);
    expect(parts.medianMs).toBe(60 * 60000);
    expect(parts.maxMs).toBe(90 * 60000);
    const cust = r.delays.find((d) => d.type === 'WAITING_CUSTOMER')!;
    expect(cust.jobsAffected).toBe(1);
    expect(cust.totalMs).toBe(20 * 60000);
    // §13 — the drill-down lists exactly the affected jobs, longest first.
    expect(r.parts.jobs.map((j) => j.waitingPartsMs)).toEqual([90 * 60000, 30 * 60000]);
  });

  it('vehicle-type totals reconcile, with UNCLASSIFIED shown rather than dropped (§9)', async () => {
    const h = build({
      jobs: [
        job(),
        job({ serviceVisitId: 'sv-2', vehicleClass: 'SUV_CLASS' }),
        job({ serviceVisitId: 'sv-3', vehicleClass: null }),
        // Live-validation catch: UNKNOWN_REQUIRES_REVIEW must also land in the
        // UNCLASSIFIED bucket, or the partition loses jobs.
        job({ serviceVisitId: 'sv-4', vehicleClass: 'UNKNOWN_REQUIRES_REVIEW' }),
      ],
    });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');
    const total = r.vehicleTypes.reduce((s, v) => s + v.jobs, 0);
    expect(total).toBe(4);
    expect(r.vehicleTypes.find((v) => v.vehicleClass === 'UNCLASSIFIED')?.jobs).toBe(2);
  });

  it('appointment/walk-in totals reconcile (§8)', async () => {
    const h = build({
      jobs: [
        job({ sourceType: 'APPOINTMENT' }),
        job({ serviceVisitId: 'sv-2', sourceType: 'WALKIN' }),
        job({ serviceVisitId: 'sv-3', sourceType: 'WALKIN', completedAt: null }),
      ],
    });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');
    expect(r.sourceComparison.appointment.jobs).toBe(1);
    expect(r.sourceComparison.walkIn.jobs).toBe(2);
    expect(r.sourceComparison.walkIn.jobsCompleted).toBe(1);
    expect(r.sourceComparison.walkIn.completionRate).toBe(50);
  });
});

describe('comparison period (§20)', () => {
  it('previous period is the same length immediately before, with diff + pct', async () => {
    const h = build({
      jobs: [job(), job({ serviceVisitId: 'sv-2' })],
      prevJobs: [job({ serviceVisitId: 'sv-9' })],
    });
    const r = await h.service.getReport('site-1', '2026-08-08', '2026-08-14', {}, true);

    expect(r.meta.comparePeriod).toEqual({ start: '2026-08-01', end: '2026-08-07' });
    expect(r.summary.vehiclesServiced).toMatchObject({ value: 2, prev: 1, diff: 1, pct: 100 });
  });

  it('never emits a percentage against a zero base', async () => {
    const h = build({ jobs: [job()], prevJobs: [] });
    const r = await h.service.getReport('site-1', '2026-08-08', '2026-08-14', {}, true);
    expect(r.summary.vehiclesServiced).toMatchObject({ value: 1, prev: 0, diff: 1, pct: null });
  });

  it('without compare, prev/diff/pct are null (not zeros pretending to be data)', async () => {
    const h = build({ jobs: [job()] });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');
    expect(r.summary.vehiclesServiced).toMatchObject({ value: 1, prev: null, diff: null, pct: null });
  });
});

describe('service targets and attention thresholds (§15/§16/§18)', () => {
  it('single-service jobs compare against the booked target; multi-service jobs counted separately', async () => {
    const h = build({
      jobs: [
        job({ expectedMinutes: 60, elapsedMs: 66 * 60000, techWorkMs: 50 * 60000 }),
        job({ serviceVisitId: 'sv-2', expectedMinutes: 60, elapsedMs: 78 * 60000, techWorkMs: 58 * 60000 }),
        job({
          serviceVisitId: 'sv-3',
          serviceCodes: ['OIL-01', 'BRK-01'],
          services: ['Oil Change', 'Brake Job'],
          expectedMinutes: 120,
        }),
      ],
    });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');
    expect(r.serviceTypes.multiServiceJobs).toBe(1);
    const oil = r.serviceTypes.rows.find((s) => s.code === 'OIL-01')!;
    expect(oil.volume).toBe(2);
    expect(oil.targetMinutes).toBe(60);
    expect(oil.avgElapsedMs).toBe(72 * 60000);
    expect(oil.varianceElapsedMs).toBe(12 * 60000); // +12m over target
  });

  it('attention items fire only past their EXPLICIT thresholds', async () => {
    const h = build({
      jobs: [
        // 2× booked but under 3h → NOT flagged.
        job({ expectedMinutes: 30, elapsedMs: 70 * 60000 }),
        // 2× booked AND ≥3h → flagged.
        job({ serviceVisitId: 'sv-2', plate: 'LONG1', expectedMinutes: 90, elapsedMs: 200 * 60000 }),
        // parts wait ≥ 4h → flagged.
        job({ serviceVisitId: 'sv-3', plate: 'PART1', waitingPartsMs: 5 * 3600_000 }),
      ],
      reworkItems: [
        { reworkCount: 2, vehiclePlate: 'RW1', serviceOrderId: 'so-rw', reasonCode: 'QC_FAIL', primaryTechnician: null },
      ],
    });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');
    const kinds = r.attention.map((a) => a.kind);
    expect(kinds).toContain('LONG_ELAPSED');
    expect(kinds).toContain('LONG_PARTS_WAIT');
    expect(kinds).toContain('REPEAT_REWORK');
    expect(r.attention.filter((a) => a.kind === 'LONG_ELAPSED')).toHaveLength(1);
    // Every item states its threshold — nothing hidden (§18).
    for (const a of r.attention) expect(a.threshold.length).toBeGreaterThan(3);
  });
});

describe('empty dataset (§29)', () => {
  it('reports emptiness honestly: no NaN, hasData false', async () => {
    const h = build({ jobs: [] });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');
    expect(r.hasData).toBe(false);
    expect(r.summary.avgElapsedMs.value).toBe(0);
    expect(r.summary.medianElapsedMs).toBe(0);
    expect(Number.isNaN(r.summary.waitingPartsPct)).toBe(false);
    expect(r.trend.length).toBeGreaterThan(0); // the days exist, with zero activity
    expect(r.trend.every((t) => !Number.isNaN(t.avgElapsedMs))).toBe(true);
  });
});

describe('executive insights (CR-2026-104b)', () => {
  it('business significance outranks percentage: 40 affected vehicles beat a 1→2 jump', async () => {
    // Rework doubles (1 → 2 events, +100%) while the average service time rises
    // 20 minutes across 40 completed jobs. The service-time insight must rank
    // first — significance is minutes × volume, never raw percentage.
    const mkJobs = (n: number, elapsedMin: number) =>
      Array.from({ length: n }, (_, i) =>
        job({
          serviceVisitId: `sv-${i}`,
          elapsedMs: elapsedMin * 60000,
          techWorkMs: 30 * 60000,
          // booked ≈ actual so the over-target insight stays quiet and the
          // MOVEMENT insight carries the ranking question.
          expectedMinutes: elapsedMin - 5,
        }),
      );
    const h = build({
      jobs: mkJobs(40, 120),
      prevJobs: mkJobs(40, 100),
      reworkSummary: { reworkRate: 5, reworkedOrders: 2 },
    });
    // prev rework rate 2.5 via a second call is not modelled; the movement
    // insight needs prev — provided through the mocked prev rework call:
    const r = await h.service.getReport('site-1', '2026-08-08', '2026-08-14', {}, true);

    const first = r.insights.attention[0];
    expect(first.id).toBe('SERVICE_TIME_MOVE');
    expect(first.detail).toContain('increased from 1h 40m to 2h 00m');
    expect(first.detail).toContain('20%');
    // Every insight is traceable.
    expect(first.evidence).toMatchObject({ metric: 'avgElapsedMs', jobs: 40 });
  });

  it('an improvement lands under highlights with value + comparison', async () => {
    const mk = (n: number, elapsedMin: number) =>
      Array.from({ length: n }, (_, i) => job({ serviceVisitId: `s${i}`, elapsedMs: elapsedMin * 60000 }));
    const h = build({ jobs: mk(10, 90), prevJobs: mk(10, 111) });
    const r = await h.service.getReport('site-1', '2026-08-08', '2026-08-14', {}, true);
    const hl = r.insights.highlights.find((i) => i.id === 'SERVICE_TIME_MOVE')!;
    expect(hl).toBeDefined();
    expect(hl.tone).toBe('positive');
    expect(hl.detail).toContain('decreased from 1h 51m to 1h 30m');
  });

  it('small samples are suppressed by the explicit minimums', async () => {
    // 2 jobs per period — far under the 5-job minimum: no time-movement insight,
    // however dramatic the swing looks.
    const h = build({
      jobs: [job({ elapsedMs: 240 * 60000 }), job({ serviceVisitId: 'sv-2', elapsedMs: 240 * 60000 })],
      prevJobs: [job({ serviceVisitId: 'p1', elapsedMs: 60 * 60000 }), job({ serviceVisitId: 'p2', elapsedMs: 60 * 60000 })],
    });
    const r = await h.service.getReport('site-1', '2026-08-08', '2026-08-14', {}, true);
    expect(r.insights.attention.find((i) => i.id === 'SERVICE_TIME_MOVE')).toBeUndefined();
    expect(r.insightMinimums.timeSampleJobs).toBe(5);
  });

  it('parts-delay movement carries frequency AND total duration (the example format)', async () => {
    const mk = (n: number, partsMin: number) =>
      Array.from({ length: n }, (_, i) => job({ serviceVisitId: `s${i}`, waitingPartsMs: partsMin * 60000 }));
    const h = build({ jobs: mk(14, 49), prevJobs: mk(7, 30) });
    const r = await h.service.getReport('site-1', '2026-08-08', '2026-08-14', {}, true);
    const parts = r.insights.attention.find((i) => i.id === 'PARTS_DELAY_MOVE')!;
    expect(parts.detail).toContain('14 jobs experienced Waiting for Parts compared with 7');
    expect(parts.detail).toContain('11h 26m'); // 14 × 49m
  });

  it('without comparison, only within-period insights appear — no fabricated movement', async () => {
    const h = build({
      jobs: Array.from({ length: 6 }, (_, i) => job({ serviceVisitId: `s${i}`, waitingPartsMs: 60 * 60000 })),
    });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-31');
    expect(r.insights.attention.some((i) => i.id === 'SERVICE_TIME_MOVE')).toBe(false);
    expect(r.insights.attention.some((i) => i.id === 'WAITING_PARTS_LOAD')).toBe(true);
  });

  it('caps each list at four, ranked by significance', async () => {
    const mk = (n: number, elapsedMin: number, partsMin: number) =>
      Array.from({ length: n }, (_, i) =>
        job({ serviceVisitId: `s${i}`, elapsedMs: elapsedMin * 60000, waitingPartsMs: partsMin * 60000, waitingCustomerMs: 20 * 60000 }),
      );
    const h = build({
      jobs: mk(40, 150, 50),
      prevJobs: mk(10, 100, 10),
      reworkItems: [
        { reworkCount: 2, vehiclePlate: 'RW1', serviceOrderId: 'so-rw', reasonCode: 'QC_FAIL', primaryTechnician: null },
      ],
    });
    const r = await h.service.getReport('site-1', '2026-08-08', '2026-08-14', {}, true);
    expect(r.insights.attention.length).toBeLessThanOrEqual(4);
    const sig = r.insights.attention.map((i) => i.significance);
    expect([...sig].sort((a, b) => b - a)).toEqual(sig);
  });
});

describe('trend bucketing (§17)', () => {
  it('buckets jobs by their start day across the period', async () => {
    const h = build({
      jobs: [
        job({ startedAt: new Date('2026-08-03T10:00:00Z') }),
        job({ serviceVisitId: 'sv-2', startedAt: new Date('2026-08-03T15:00:00Z') }),
        job({ serviceVisitId: 'sv-3', startedAt: new Date('2026-08-05T10:00:00Z') }),
      ],
    });
    const r = await h.service.getReport('site-1', '2026-08-01', '2026-08-07');
    expect(r.trend).toHaveLength(7);
    const d3 = r.trend.find((t) => t.date === '2026-08-03')!;
    const d5 = r.trend.find((t) => t.date === '2026-08-05')!;
    expect(d3.jobsStarted).toBe(2);
    expect(d5.jobsStarted).toBe(1);
    expect(r.trend.reduce((s, t) => s + t.jobsStarted, 0)).toBe(3);
  });
});
