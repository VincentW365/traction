import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportingService } from '../reporting.service';
import { HISTORICAL_VISIT_SOURCE_TYPE } from '../../../common/helpers/operational-scope';

/**
 * CR-2026-006 — operational scope filtering for reporting.
 * Verifies that getKpis excludes HISTORICAL_IMPORT visits BY DEFAULT (both the
 * Prisma `serviceVisit.count` where-clause AND the raw avg-wait SQL fragment),
 * and that includeHistorical=true removes the filter.
 *
 * Mocked PrismaService — no DB, no PII fixtures (markers are non-PII codes).
 */
function buildService() {
  const counts = { serviceVisit: 0, appointment: 0, auditLog: 0 };
  const prisma: any = {
    serviceVisit: { count: vi.fn(async () => counts.serviceVisit) },
    appointment: { count: vi.fn(async () => counts.appointment) },
    auditLog: { count: vi.fn(async () => counts.auditLog) },
    // Tagged-template mock: receives (strings, ...values). The last value is the
    // composed live-visit SQL fragment.
    $queryRaw: vi.fn(async () => [] as Array<{ avg_wait: number | null }>),
  };
  const service = new ReportingService(prisma as any);
  return { service, prisma };
}

describe('ReportingService.getKpis operational scope (CR-2026-006)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('excludes HISTORICAL_IMPORT by default (Prisma count where + raw fragment)', async () => {
    await h.service.getKpis('site-1', '2026-01-01', '2026-01-31');

    // First serviceVisit.count is totalCheckedIn — must carry the live filter.
    const totalCheckedInWhere = h.prisma.serviceVisit.count.mock.calls[0][0].where;
    expect(totalCheckedInWhere.sourceType).toEqual({ not: HISTORICAL_VISIT_SOURCE_TYPE });

    // Raw avg-wait query: the last interpolated value is the live-visit fragment.
    const rawCall = h.prisma.$queryRaw.mock.calls[0];
    const fragment = rawCall[rawCall.length - 1];
    expect(fragment.strings.join('')).toContain('source_type');
  });

  it('includeHistorical=true removes the historical filter (test-data exclusion remains, CR-2026-020)', async () => {
    await h.service.getKpis('site-1', '2026-01-01', '2026-01-31', true);

    // historical opt-in drops sourceType; the test-data filter stays on by default.
    const totalCheckedInWhere = h.prisma.serviceVisit.count.mock.calls[0][0].where;
    expect(totalCheckedInWhere.sourceType).toBeUndefined();
    expect(totalCheckedInWhere.testDataRunId).toBeNull();

    // Raw fragment no longer carries source_type, but still excludes test data.
    const rawCall = h.prisma.$queryRaw.mock.calls[0];
    const fragment = rawCall[rawCall.length - 1];
    expect(fragment.strings.join('')).not.toContain('source_type');
    expect(fragment.strings.join('')).toContain('test_data_run_id IS NULL');
  });
});
