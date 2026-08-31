import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManagerDashboardService } from '../manager-dashboard.service';
import { HISTORICAL_VISIT_SOURCE_TYPE } from '../../../common/helpers/operational-scope';

/**
 * CR-2026-006 — the manager dashboard is an ALWAYS-LIVE surface (no opt-in):
 * historical/placeholder records must never appear, regardless of arguments.
 */
function buildService() {
  const prisma: any = {
    serviceVisit: { count: vi.fn(async () => 0) },
    technician: { count: vi.fn(async () => 0) },
    serviceOrder: { count: vi.fn(async () => 0) },
    queueTicket: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    partsRequest: { count: vi.fn(async () => 0) },
  };
  return { service: new ManagerDashboardService(prisma as any), prisma };
}

const liveVisit = { sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE } };

describe('ManagerDashboardService is always-live (CR-2026-006)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('carsToday always excludes HISTORICAL_IMPORT visits', async () => {
    await h.service.getDashboard('site-1');
    const where = h.prisma.serviceVisit.count.mock.calls[0][0].where;
    expect(where.sourceType).toEqual(liveVisit.sourceType);
  });

  it('jobsInProgress filters historical via nested serviceVisit', async () => {
    await h.service.getDashboard('site-1');
    // jobsInProgress is the first serviceOrder.count call.
    const where = h.prisma.serviceOrder.count.mock.calls[0][0].where;
    expect(where.serviceVisit.sourceType).toEqual(liveVisit.sourceType);
  });

  it('operational counts exclude children of terminal visits (CR-2026-098c)', async () => {
    // An ASSIGNED order under an ABANDONED visit sat in "Jobs In Progress" for
    // weeks, and stale tickets under closed visits inflated the queue counts.
    await h.service.getDashboard('site-1');
    const orderWhere = h.prisma.serviceOrder.count.mock.calls[0][0].where;
    expect(orderWhere.serviceVisit.status).toEqual({ notIn: ['CLOSED', 'ABANDONED', 'CANCELLED'] });
    const ticketWhere = h.prisma.queueTicket.count.mock.calls[0][0].where;
    expect(ticketWhere.serviceVisit.status).toEqual({ notIn: ['CLOSED', 'ABANDONED', 'CANCELLED'] });
  });
});
