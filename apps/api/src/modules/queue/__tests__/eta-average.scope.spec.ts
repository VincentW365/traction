import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueService } from '../queue.service';

/**
 * CR-2026-007 — ETA average isolation.
 * getAvgServiceMinutes (private) is exercised through getBoard, which surfaces
 * the resulting `etaBasis`. Verifies the three tiers:
 *   LIVE                -> live sample >= threshold
 *   HISTORICAL_FALLBACK -> live sample below threshold, all-time data available
 *   DEFAULT             -> no data anywhere
 * Plus: the live query reuses operational-scope `liveVisitSql('sv')`, and the
 * PUBLIC display board never exposes etaBasis (behavior unchanged).
 *
 * Mocked PrismaService — no DB, no PII fixtures.
 */
function ticket(queueRank: number) {
  return {
    id: 't1',
    ticketNumber: 'A001',
    queueRank,
    displayStatus: 'WAITING',
    blockedReason: null,
    readyForDispatch: false,
    overrideActive: false,
    overrideReasonCode: null,
    serviceVisit: {
      sourceType: 'WALKIN',
      appointment: null,
      partsReadiness: 'NOT_REQUIRED',
      checkedInAt: null,
      queuePriorityClass: null,
    },
  };
}

function buildService() {
  const prisma: any = {
    queueTicket: { findMany: vi.fn(async () => []) },
    businessRuleConfig: { findFirst: vi.fn(async () => null) }, // use defaults (30d / 20)
    $queryRaw: vi.fn(async () => [{ count: 0n, avg: null }]),
    site: { findUnique: vi.fn(async () => ({ name: 'Bert Service Centre' })) },
    resourceOccupancy: { findMany: vi.fn(async () => []) },
    serviceVisit: { findMany: vi.fn(async () => []) },
  };
  const service = new QueueService(prisma as any, {} as any, {} as any, {} as any);
  return { service, prisma };
}

// Concatenate the SQL text of all Prisma.Sql fragments interpolated into a
// $queryRaw call (liveVisitSql, capSql, ...), and collect their bound values.
const sqlOf = (call: any[]) => call.filter((a) => a && a.strings).map((a) => a.strings.join('')).join(' ');
const valuesOf = (call: any[]) => call.filter((a) => a && Array.isArray(a.values)).flatMap((a) => a.values);

describe('QueueService ETA average isolation (CR-2026-007)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('LIVE: uses live window average when sample >= threshold; reuses liveVisitSql', async () => {
    h.prisma.queueTicket.findMany.mockResolvedValueOnce([ticket(2)]);
    // Tier-1 (live) query result: 25 orders, 42 min avg.
    h.prisma.$queryRaw.mockResolvedValueOnce([{ count: 25n, avg: 42 }]);

    const board = await h.service.getBoard('site-1');

    expect(board.etaBasis).toBe('LIVE');
    expect(board.etaSampleSize).toBe(25);
    // ETA multiplier flows through: rank 2 * 42 min.
    expect(board.items[0].estimatedWaitMinutes).toBe(84);

    // The live query must carry the operational-scope live-visit fragment.
    expect(sqlOf(h.prisma.$queryRaw.mock.calls[0])).toContain('source_type');
    // Only ONE query ran (no fallback needed).
    expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('HISTORICAL_FALLBACK: live sample below threshold falls back to all-time', async () => {
    h.prisma.$queryRaw
      .mockResolvedValueOnce([{ count: 5n, avg: 40 }])    // tier 1: too small
      .mockResolvedValueOnce([{ count: 9000n, avg: 95 }]); // tier 2: all-time

    const board = await h.service.getBoard('site-1');

    expect(board.etaBasis).toBe('HISTORICAL_FALLBACK');
    expect(board.etaSampleSize).toBe(9000);
    expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('DEFAULT: no data anywhere falls back to the 30-minute constant', async () => {
    h.prisma.queueTicket.findMany.mockResolvedValueOnce([ticket(2)]);
    h.prisma.$queryRaw
      .mockResolvedValueOnce([{ count: 0n, avg: null }])  // tier 1 empty
      .mockResolvedValueOnce([{ count: 0n, avg: null }]); // tier 2 empty

    const board = await h.service.getBoard('site-1');

    expect(board.etaBasis).toBe('DEFAULT');
    expect(board.etaSampleSize).toBe(0);
    expect(board.items[0].estimatedWaitMinutes).toBe(60); // rank 2 * 30 default
  });

  it('reads window/threshold from BusinessRuleConfig (not hard-coded)', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([{ count: 25n, avg: 42 }]);
    await h.service.getBoard('site-1');
    const keys = h.prisma.businessRuleConfig.findFirst.mock.calls.map(
      (c: any) => c[0].where.ruleKey,
    );
    expect(keys).toContain('eta_avg_live_window_days');
    expect(keys).toContain('eta_avg_min_live_sample');
  });

  it('CR-2026-015: applies the outlier cap to BOTH tiers when configured', async () => {
    h.prisma.businessRuleConfig.findFirst.mockImplementation(async ({ where }: any) =>
      where.ruleKey === 'eta_avg_outlier_cap_minutes' ? { valueJson: 90 } : null,
    );
    h.prisma.$queryRaw
      .mockResolvedValueOnce([{ count: 5n, avg: 40 }])     // tier 1 (small) → fallback
      .mockResolvedValueOnce([{ count: 9000n, avg: 95 }]); // tier 2

    await h.service.getBoard('site-1');

    const keys = h.prisma.businessRuleConfig.findFirst.mock.calls.map((c: any) => c[0].where.ruleKey);
    expect(keys).toContain('eta_avg_outlier_cap_minutes');

    for (const call of h.prisma.$queryRaw.mock.calls) {
      expect(sqlOf(call)).toContain('started_at)) / 60 <='); // cap predicate present
      expect(valuesOf(call)).toContain(90); // cap value bound (parameterized)
    }
  });

  it('CR-2026-015: no cap clause when the key is absent (default behavior unchanged)', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([{ count: 25n, avg: 42 }]); // LIVE path
    await h.service.getBoard('site-1');

    const call = h.prisma.$queryRaw.mock.calls[0];
    expect(sqlOf(call)).not.toContain('started_at)) / 60 <=');
    expect(valuesOf(call)).not.toContain(90);
  });

  it('PUBLIC display board never exposes etaBasis (behavior unchanged)', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([{ count: 25n, avg: 42 }]);
    const board: any = await h.service.getPublicDisplayBoard('site-1');

    expect(board).not.toHaveProperty('etaBasis');
    expect(board).not.toHaveProperty('etaSampleSize');
    expect(board).toHaveProperty('inQueue');
    expect(board).toHaveProperty('inService');
    expect(board).toHaveProperty('ready');
  });
});
