import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaintenanceReminderService } from '../maintenance-reminder.service';
import { HISTORICAL_VISIT_SOURCE_TYPE } from '../../../common/helpers/operational-scope';

/**
 * CR-2026-006 — the average-daily-miles cadence model is ALWAYS-LIVE: it must
 * exclude HISTORICAL_IMPORT visits, whose back-loaded odometer/check-in data
 * would distort the mileage estimate. No opt-in.
 */
function buildService() {
  const prisma: any = {
    serviceVisit: { findMany: vi.fn(async () => []) },
  };
  const service = new MaintenanceReminderService(
    prisma as any,
    { log: vi.fn() } as any,
    {} as any,
  );
  return { service, prisma };
}

describe('MaintenanceReminderService.calculateAverageDailyMiles always-live (CR-2026-006)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('excludes HISTORICAL_IMPORT visits from the mileage model', async () => {
    await h.service.calculateAverageDailyMiles('veh-1');
    const where = h.prisma.serviceVisit.findMany.mock.calls[0][0].where;
    expect(where.sourceType).toEqual({ not: HISTORICAL_VISIT_SOURCE_TYPE });
  });
});
