import { describe, it, expect, vi } from 'vitest';
import { PerformanceService } from '../performance.service';

/**
 * CR-2026-044 — technician performance now reports quality (first-time-fix /
 * rework) and a primary/helper workload split alongside labour efficiency.
 * FTF is measured over PRIMARY jobs: of the jobs a tech led, the share that did
 * not come back as rework (ServiceOrder.reworks).
 */
function min(n: number) {
  return new Date(2026, 0, 1, 0, n, 0); // a Date n minutes past a fixed epoch
}

function techWith(assignments: unknown[]) {
  const prisma: any = {
    technician: {
      findMany: vi.fn(async () => [
        { id: 'tech-1', employeeCode: 'T1', userAccount: { fullName: 'Tech One' }, assignments },
      ]),
    },
  };
  return new PerformanceService(prisma as any);
}

describe('PerformanceService.getTechnicianEfficiency — quality metrics (CR-2026-044)', () => {
  it('computes first-time-fix over primary jobs and counts rework', async () => {
    const service = techWith([
      // primary, clean, 60 min, est 90
      { isPrimary: true, status: 'COMPLETED', startedAt: min(0), endedAt: min(60), serviceOrder: { items: [{ estimateMinutes: 90 }], _count: { reworks: 0 } } },
      // primary, CAME BACK, 30 min, est 30
      { isPrimary: true, status: 'COMPLETED', startedAt: min(0), endedAt: min(30), serviceOrder: { items: [{ estimateMinutes: 30 }], _count: { reworks: 2 } } },
      // primary, clean, no clock time, est 20
      { isPrimary: true, status: 'COMPLETED', startedAt: null, endedAt: null, serviceOrder: { items: [{ estimateMinutes: 20 }], _count: { reworks: 0 } } },
      // primary, still in progress, no rework
      { isPrimary: true, status: 'IN_PROGRESS', startedAt: null, endedAt: null, serviceOrder: { items: [], _count: { reworks: 0 } } },
      // helper, 45 min — excluded from flagged + FTF
      { isPrimary: false, status: 'COMPLETED', startedAt: min(0), endedAt: min(45), serviceOrder: { items: [{ estimateMinutes: 999 }], _count: { reworks: 1 } } },
    ]);

    const [row] = await service.getTechnicianEfficiency('site-1', '2026-01-01', '2026-01-31');

    expect(row.primaryJobs).toBe(4);
    expect(row.helperJobs).toBe(1);
    expect(row.reworkedJobs).toBe(1); // only the primary "came back" job counts
    expect(row.firstTimeFixRate).toBe(75); // (1 - 1/4) * 100
    expect(row.jobsCompleted).toBe(4); // 3 primary COMPLETED + 1 helper COMPLETED
    expect(row.flaggedMinutes).toBe(140); // 90 + 30 + 20 (primary only; helper excluded)
    expect(row.clockMinutes).toBe(135); // 60 + 30 + 45
    expect(row.avgJobMinutes).toBe(34); // round(135 / 4)
  });

  it('reports null first-time-fix when the tech had no primary jobs', async () => {
    const service = techWith([
      { isPrimary: false, status: 'COMPLETED', startedAt: min(0), endedAt: min(20), serviceOrder: { items: [], _count: { reworks: 0 } } },
    ]);
    const [row] = await service.getTechnicianEfficiency('site-1', '2026-01-01', '2026-01-31');
    expect(row.primaryJobs).toBe(0);
    expect(row.firstTimeFixRate).toBeNull();
    expect(row.reworkedJobs).toBe(0);
  });
});
