import { describe, it, expect, vi } from 'vitest';
import { KpiReportingService } from '../kpi-reporting.service';

/**
 * CR-2026-091 — what a technician's numbers are divided by.
 *
 * The rule: only a formally ELIGIBLE job counts. A job held for benchmark review is
 * work the technician genuinely did, but nobody had said what to measure it against —
 * so counting it as a miss charges them for an administrative gap, and counting it as
 * a hit inflates them. It is out of the denominator entirely, and the exclusion is
 * reported so a low job count reads as "held for review", not as a quiet month.
 *
 * This lives in a test because the rule used to exist only as one filter line in the
 * dashboard page, where it was one careless edit away from silently changing whose
 * numbers looked good.
 */
function snapshot(over: Record<string, any> = {}) {
  return {
    kpiCompletionMinutes: 100,
    varianceMinutes: 10,
    approvedExcludedMinutes: 0,
    adjustedTechnicianRating: 'MEETS_TARGET',
    absoluteCompletionRating: 'EXCELLENT',
    onTarget: true,
    vehicleClass: 'SEDAN_CLASS',
    packageType: 'GENERAL_SERVICE_ONLY',
    eligibilityStatus: 'ELIGIBLE',
    isSharedOrReassigned: false,
    hadRework: false,
    primaryTechnicianId: 'tech-1',
    pendingBenchmarkReview: false,
    ...over,
  };
}

function build(snapshots: any[]) {
  const prisma: any = {
    workOrderKpiSnapshot: { findMany: vi.fn(async () => snapshots) },
    technician: {
      findMany: vi.fn(async () => [
        { id: 'tech-1', employeeCode: 'T01', userAccount: { fullName: 'Marcus' } },
      ]),
    },
    kpiDelayEvent: { groupBy: vi.fn(async () => []) },
  };
  return new KpiReportingService(prisma as any);
}

describe('technician KPI denominators', () => {
  it('excludes a job held for benchmark review', async () => {
    const svc = build([
      snapshot(),
      snapshot(),
      snapshot({
        eligibilityStatus: 'PENDING_BENCHMARK_REVIEW',
        pendingBenchmarkReview: true,
        onTarget: false,
        adjustedTechnicianRating: null,
        absoluteCompletionRating: null,
        varianceMinutes: null,
      }),
    ]);

    const d = await svc.getDashboard({});

    // Two eligible jobs, both on target. The held job neither helps nor harms.
    expect(d.eligibleJobs).toBe(2);
    expect(d.totalJobs).toBe(3);
    expect(d.adjustedOnTargetPercent).toBe(100);
    expect(d.byTechnician[0].jobs).toBe(2);
    expect(d.byTechnician[0].onTargetPercent).toBe(100);
  });

  it('a held job does not drag the percentage down', async () => {
    // The failure this guards against: onTarget defaults to false on an unrated job,
    // so counting it would read as a miss the technician never made.
    const withheld = build([
      snapshot(),
      snapshot({
        eligibilityStatus: 'PENDING_BENCHMARK_REVIEW',
        pendingBenchmarkReview: true,
        onTarget: false,
      }),
    ]);
    const d = await withheld.getDashboard({});
    expect(d.byTechnician[0].onTargetPercent).toBe(100);
    expect(d.adjustedOnTargetPercent).toBe(100);
  });

  it('reports the held jobs separately so the gap is visible', async () => {
    const svc = build([
      snapshot(),
      snapshot({ eligibilityStatus: 'PENDING_BENCHMARK_REVIEW', pendingBenchmarkReview: true }),
    ]);
    const d = await svc.getDashboard({});

    expect(d.pendingBenchmarkReviewJobs).toBe(1);
    expect(d.byTechnician[0].excludedPendingReview).toBe(1);
  });

  it('distinguishes held jobs from jobs with no agreed standard', async () => {
    const svc = build([
      snapshot({ eligibilityStatus: 'PENDING_BENCHMARK_REVIEW', pendingBenchmarkReview: true }),
      snapshot({ eligibilityStatus: 'NOT_BENCHMARKED', packageType: 'CUSTOM_UNBENCHMARKED' }),
    ]);
    const d = await svc.getDashboard({});

    expect(d.pendingBenchmarkReviewJobs).toBe(1);
    expect(d.byIneligibility.PENDING_BENCHMARK_REVIEW).toBe(1);
    expect(d.byIneligibility.NOT_BENCHMARKED).toBe(1);
    // Both are unrated, so neither is in the denominator.
    expect(d.eligibleJobs).toBe(0);
  });

  it('still excludes shared and reassigned jobs, and says so', async () => {
    const svc = build([snapshot(), snapshot({ isSharedOrReassigned: true })]);
    const d = await svc.getDashboard({});

    expect(d.byTechnician[0].jobs).toBe(1);
    expect(d.byTechnician[0].excludedSharedOrReassigned).toBe(1);
    expect(d.sharedOrReassignedJobs).toBe(1);
  });

  it('a technician with only held jobs does not appear as a zero-percent performer', async () => {
    // Ranking someone at 0% because their only job was awaiting a mapping would be the
    // worst version of this bug — a visible, permanent, undeserved bad number.
    const svc = build([
      snapshot({
        eligibilityStatus: 'PENDING_BENCHMARK_REVIEW',
        pendingBenchmarkReview: true,
        onTarget: false,
      }),
    ]);
    const d = await svc.getDashboard({});

    expect(d.byTechnician).toHaveLength(0);
  });

  it('rework and first-pass rates still cover every job', async () => {
    // Deliberately NOT restricted to eligible jobs: whether QC sent work back is a
    // quality fact that does not depend on having a time standard.
    const svc = build([
      snapshot({ hadRework: true }),
      snapshot({ eligibilityStatus: 'PENDING_BENCHMARK_REVIEW', pendingBenchmarkReview: true }),
    ]);
    const d = await svc.getDashboard({});

    expect(d.reworkRate).toBe(50);
  });
});
