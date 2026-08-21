import { describe, it, expect, vi } from 'vitest';
import { KpiService } from '../kpi.service';

/**
 * CR-2026-092 — a finished job is never re-benchmarked.
 *
 * The seed's own shape is asserted by scripts/verify-kpi-contributions.mjs, which runs
 * against the seeded database. It deliberately does NOT live here: importing the Prisma
 * seed into the API's compilation unit puts a file outside rootDir into the build, and
 * a test that breaks 'nest build' is worse than the drift it was guarding against.
 */

// ---------------------------------------------------------------------------
// Completed snapshots stay immutable
// ---------------------------------------------------------------------------
describe('a finished job is never re-benchmarked', () => {
  function build(snapshot: Record<string, unknown>) {
    const prisma: any = {
      workOrderKpiSnapshot: {
        findUnique: vi.fn(async () => snapshot),
        update: vi.fn(async () => snapshot),
        create: vi.fn(),
      },
      serviceOrder: { findUnique: vi.fn(async () => null) },
      kpiPolicy: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
      kpiServiceComponent: { findMany: vi.fn(async () => []) },
      kpiDelayEvent: { findMany: vi.fn(async () => []) },
      businessRuleConfig: { findFirst: vi.fn(async () => null) },
    };
    const audit = { log: vi.fn(async () => ({})) };
    return { service: new KpiService(prisma as any, audit as any), prisma };
  }

  it('a scope change after finalisation does not revise the standard', () => {
    const h = build({ id: 'snap-1', finalisedAt: new Date(), standardMinutes: 90 });
    return h.service.reevaluatePackage('so-1', 'user-1').then(() => {
      expect(h.prisma.workOrderKpiSnapshot.update).not.toHaveBeenCalled();
    });
  });

  it('a job that never started has nothing to revise', () => {
    const prismaless = build(null as never);
    return prismaless.service.reevaluatePackage('so-1', 'user-1').then(() => {
      expect(prismaless.prisma.workOrderKpiSnapshot.update).not.toHaveBeenCalled();
    });
  });
});
