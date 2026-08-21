import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerformanceService } from '../performance.service';
import { HISTORICAL_VISIT_SOURCE_TYPE } from '../../../common/helpers/operational-scope';

/**
 * CR-2026-006 — technician performance reads exclude assignments tied to
 * HISTORICAL_IMPORT visits. getTechnicianEfficiency / getTechnicianPerformance
 * are always-live; getAssignmentHistory accepts the includeHistorical opt-in.
 *
 * CR-2026-020 — the live-visit filter now ALSO excludes test-data-sandbox visits
 * by default (`testDataRunId: null`), independently of includeHistorical. This is
 * a no-op until a test run exists (real/imported visits have no run id).
 */
function buildService() {
  const prisma: any = {
    // CR-2026-086 - getTechnicianEfficiency reads the KPI rating bands from
    // BusinessRuleConfig; absent rule falls back to the seeded benchmark.
    businessRuleConfig: { findFirst: vi.fn(async () => null) },
    technician: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    technicianAssignment: { findMany: vi.fn(async () => []) },
  };
  return { service: new PerformanceService(prisma as any), prisma };
}

const liveVisit = { sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE }, testDataRunId: null };

describe('PerformanceService operational scope (CR-2026-006)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('getTechnicianEfficiency always filters historical visits (nested relation)', async () => {
    await h.service.getTechnicianEfficiency('site-1', '2026-01-01', '2026-01-31');
    const include = h.prisma.technician.findMany.mock.calls[0][0].include;
    expect(include.assignments.where.serviceOrder.serviceVisit).toEqual(liveVisit);
  });

  it('getTechnicianPerformance always filters historical visits', async () => {
    await h.service.getTechnicianPerformance('tech-1', '2026-01-01', '2026-01-31');
    const where = h.prisma.technicianAssignment.findMany.mock.calls[0][0].where;
    expect(where.serviceOrder.serviceVisit).toEqual(liveVisit);
  });

  it('getAssignmentHistory excludes historical by default', async () => {
    await h.service.getAssignmentHistory('site-1', '2026-01-01', '2026-01-31');
    const where = h.prisma.technicianAssignment.findMany.mock.calls[0][0].where;
    expect(where.serviceOrder.serviceVisit).toEqual(liveVisit);
  });

  it('getAssignmentHistory includeHistorical=true removes the historical filter (test-data filter remains)', async () => {
    await h.service.getAssignmentHistory('site-1', '2026-01-01', '2026-01-31', true);
    const where = h.prisma.technicianAssignment.findMany.mock.calls[0][0].where;
    // historical opt-in drops sourceType; test-data exclusion (CR-2026-020) stays on.
    expect(where.serviceOrder.serviceVisit).toEqual({ testDataRunId: null });
  });
});
