import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScheduleService } from '../schedule.service';
import { HISTORICAL_VISIT_SOURCE_TYPE } from '../../../common/helpers/operational-scope';

/**
 * CR-2026-006 — the schedule views are ALWAYS-LIVE (no opt-in). The completed-
 * visit projections (day timeline + week summary) must exclude HISTORICAL_IMPORT
 * visits, whose recent import updatedAt would otherwise appear as "completed today".
 */
function buildService() {
  const prisma: any = {
    businessRuleConfig: { findFirst: vi.fn(async () => null) },
    workResource: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    resourceReservation: { findMany: vi.fn(async () => []) },
    resourceOccupancy: { findMany: vi.fn(async () => []) },
    serviceVisit: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    queueTicket: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    technicianAssignment: { findMany: vi.fn(async () => []) },
    appointment: { count: vi.fn(async () => 0) },
  };
  return { service: new ScheduleService(prisma as any), prisma };
}

const liveVisit = { sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE } };

describe('ScheduleService is always-live (CR-2026-006)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('getDaySchedule completedVisits excludes HISTORICAL_IMPORT', async () => {
    await h.service.getDaySchedule('site-1', '2026-06-09');
    // completedVisits is the first serviceVisit.findMany call.
    const where = h.prisma.serviceVisit.findMany.mock.calls[0][0].where;
    expect(where.sourceType).toEqual(liveVisit.sourceType);
  });

  it('getWeekSchedule completedCount excludes HISTORICAL_IMPORT every day', async () => {
    await h.service.getWeekSchedule('site-1', '2026-06-07');
    expect(h.prisma.serviceVisit.count).toHaveBeenCalled();
    for (const call of h.prisma.serviceVisit.count.mock.calls) {
      expect(call[0].where.sourceType).toEqual(liveVisit.sourceType);
    }
  });
});
