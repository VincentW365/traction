import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-073 — the assigned technician finishes work → sends the order to QC, and the
 * work-timing read used to drive the tech's elapsed / actual-working timers.
 */
function build(opts: { callerTech?: any; timingOrder?: any; pauses?: any[]; otherActive?: number } = {}) {
  const prisma: any = {
    technician: { findUnique: vi.fn(async () => opts.callerTech ?? null) },
    technicianAssignment: { updateMany: vi.fn(async () => ({ count: 1 })) },
    serviceOrder: {
      findUnique: vi.fn(async () => opts.timingOrder ?? null),
      count: vi.fn(async () => opts.otherActive ?? 0),
    },
    serviceOrderPause: { findMany: vi.fn(async () => opts.pauses ?? []) },
    resourceOccupancy: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const scheduling = { recomputeQueue: vi.fn(async () => ({})) };
  const service = new ServiceOrdersService(prisma as any, statusHistory as any, audit as any, scheduling as any,
    // CR-2026-088 - KPI hooks. Stubbed: these tests exercise the order state
    // machine, not the KPI framework, which has its own suite.
    {
      assertVehicleClassConfirmed: vi.fn(async () => undefined),
      openSnapshotOnStart: vi.fn(async () => undefined),
      captureSnapshotOnQc: vi.fn(async () => undefined),
      reevaluatePackage: vi.fn(async () => undefined),
    } as any,
  );
  const changeStatus = vi.spyOn(service as any, 'changeStatus').mockResolvedValue({});
  return { service, prisma, changeStatus };
}

function order(overrides: any = {}) {
  return {
    id: 'so-1',
    status: 'IN_PROGRESS',
    serviceVisitId: 'v1',
    serviceVisit: { siteId: 's1' },
    items: [],
    assignments: [{ technicianId: 'tech-1', endedAt: null }],
    ...overrides,
  };
}

describe('readyForQc (CR-2026-073)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('the assigned technician sends an IN_PROGRESS order to QC, ends the assignment, frees the bay', async () => {
    const h = build({ callerTech: { id: 'tech-1' }, otherActive: 0 });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await h.service.readyForQc('so-1', 'u1');

    expect(h.changeStatus).toHaveBeenCalledWith('so-1', { toStatus: 'QC' }, 'u1');
    expect(h.prisma.technicianAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serviceOrderId: 'so-1', endedAt: null } }),
    );
    // CR-2026-075 — frees the dispatch occupancy when no other active order holds the visit.
    expect(h.prisma.resourceOccupancy.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { serviceVisitId: 'v1', status: 'OCCUPIED' },
        data: expect.objectContaining({ status: 'AVAILABLE' }),
      }),
    );
  });

  it('does NOT free the bay while another order on the same visit is still active', async () => {
    const h = build({ callerTech: { id: 'tech-1' }, otherActive: 1 });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await h.service.readyForQc('so-1', 'u1');

    expect(h.prisma.resourceOccupancy.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a technician who is not assigned to the order', async () => {
    const h = build({ callerTech: { id: 'tech-2' } });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);
    await expect(h.service.readyForQc('so-1', 'u2')).rejects.toThrow(/assigned technician/i);
    expect(h.changeStatus).not.toHaveBeenCalled();
  });

  it('rejects when the order is not IN_PROGRESS (e.g. PAUSED)', async () => {
    const h = build({ callerTech: { id: 'tech-1' } });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order({ status: 'PAUSED' }) as any);
    await expect(h.service.readyForQc('so-1', 'u1')).rejects.toThrow(/resume the work first/i);
    expect(h.changeStatus).not.toHaveBeenCalled();
  });
});

describe('getWorkTiming (CR-2026-073)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sums closed pauses and reports the open pause start', async () => {
    const h = build({
      timingOrder: { startedAt: new Date('2026-07-06T10:00:00Z'), completedAt: null, status: 'PAUSED' },
      pauses: [
        { startedAt: new Date('2026-07-06T10:10:00Z'), endedAt: new Date('2026-07-06T10:15:00Z') }, // 5 min
        { startedAt: new Date('2026-07-06T10:30:00Z'), endedAt: null }, // open
      ],
    });
    const res = await h.service.getWorkTiming('so-1');
    expect(res.pausedMs).toBe(5 * 60 * 1000);
    expect(res.openPauseStartedAt).toEqual(new Date('2026-07-06T10:30:00Z'));
    expect(res.status).toBe('PAUSED');
  });

  it('404s when the order does not exist', async () => {
    const h = build({ timingOrder: null });
    await expect(h.service.getWorkTiming('missing')).rejects.toThrow(/not found/i);
  });
});
