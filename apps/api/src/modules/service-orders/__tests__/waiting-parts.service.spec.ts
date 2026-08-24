import { describe, it, expect, vi } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-098 — Waiting for Parts as a measured operational state.
 *
 * One gesture ("Waiting for parts" in the pause menu) → the first-class
 * WAITING_PARTS status, an open interval in the pause ledger, labour stopped.
 * Resume closes the interval and restarts labour. Cancellation closes any open
 * interval. Durations sum across multiple periods.
 */

function orderIn(status: string) {
  return {
    id: 'so-1',
    status,
    serviceVisitId: 'sv-1',
    startedAt: new Date('2026-08-24T10:00:00Z'),
    serviceVisit: { id: 'sv-1', siteId: 'site-1', status: 'IN_SERVICE' },
  };
}

function buildService() {
  const prisma: any = {
    serviceOrder: {
      update: vi.fn(async ({ data }: any) => ({ id: 'so-1', ...data, serviceVisit: { id: 'sv-1', siteId: 'site-1', status: 'IN_SERVICE' } })),
      findUnique: vi.fn(async () => orderIn('IN_PROGRESS')),
    },
    serviceVisit: { update: vi.fn(async () => ({})) },
    technicianAssignment: { updateMany: vi.fn(async () => ({ count: 0 })) },
    queueTicket: {
      findUnique: vi.fn(async () => ({ id: 'qt-1', displayStatus: 'IN_SERVICE' })),
      update: vi.fn(async () => ({})),
    },
    serviceOrderPause: {
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => []),
    },
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));

  const statusHistory = { record: vi.fn(async () => ({})) };
  const auditService = { log: vi.fn(async () => ({})) };
  const schedulingService = { recomputeQueue: vi.fn(async () => ({})) };
  const kpi = { onSubmitToQc: vi.fn(async () => ({})), onQcPassed: vi.fn(async () => ({})) };
  const segments = {
    endAllForOrder: vi.fn(async () => ({})),
    resumeForOrder: vi.fn(async () => ({})),
    startForAssignment: vi.fn(async () => ({})),
  };

  const service = new ServiceOrdersService(
    prisma as any,
    statusHistory as any,
    auditService as any,
    schedulingService as any,
    kpi as any,
    segments as any,
  );
  return { service, prisma, statusHistory, segments };
}

describe('pause → Waiting for Parts (CR-2026-098)', () => {
  it('routes the WAITING_PARTS pause reason into the first-class status, not a generic pause', async () => {
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('IN_PROGRESS') as never);

    await h.service.pause('so-1', { reasonCode: 'WAITING_PARTS', notes: 'brake pads on order' } as never, 'tech-1');

    // Status lands on WAITING_PARTS…
    expect(h.prisma.serviceOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'WAITING_PARTS' }) }),
    );
    // …with an open measured interval carrying the note…
    expect(h.prisma.serviceOrderPause.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reasonCode: 'WAITING_PARTS', pausedByUserId: 'tech-1', notes: 'brake pads on order' }),
      }),
    );
    // …and the labour clock stopped.
    expect(h.segments.endAllForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: 'so-1', endReason: 'PAUSED' }),
    );
    // The visit reflects the parts delay for advisor/manager views.
    expect(h.prisma.serviceVisit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'WAITING_PARTS' } }),
    );
  });

  it('an ordinary pause reason still produces PAUSED (normal jobs unaffected)', async () => {
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('IN_PROGRESS') as never);

    await h.service.pause('so-1', { reasonCode: 'BREAK_OR_END_OF_DAY' } as never, 'tech-1');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PAUSED' } }),
    );
    // No visit-status change on an ordinary pause (recording-only semantics kept).
    expect(h.prisma.serviceVisit.update).not.toHaveBeenCalled();
  });

  it('resume from WAITING_PARTS closes the interval and restarts labour', async () => {
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('WAITING_PARTS') as never);

    await h.service.resume('so-1', {} as never, 'tech-1');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_PROGRESS' }) }),
    );
    expect(h.prisma.serviceOrderPause.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { serviceOrderId: 'so-1', endedAt: null },
        data: expect.objectContaining({ resumedByUserId: 'tech-1' }),
      }),
    );
    expect(h.segments.resumeForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: 'so-1' }),
    );
  });

  it('cancelling a waiting job closes its open interval — waiting time cannot grow forever', async () => {
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('WAITING_PARTS') as never);

    await h.service.changeStatus('so-1', { toStatus: 'CANCELLED' } as never, 'mgr-1');

    expect(h.prisma.serviceOrderPause.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serviceOrderId: 'so-1', endedAt: null } }),
    );
  });

  it('logically impossible: cannot mark a QC/completed job as waiting for parts', async () => {
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('QC') as never);
    await expect(
      h.service.pause('so-1', { reasonCode: 'WAITING_PARTS' } as never, 'tech-1'),
    ).rejects.toThrow(/Invalid status transition/);
  });
});

describe('work timing — multiple waiting periods', () => {
  it('sums closed intervals, breaks out parts time, and exposes the open interval reason', async () => {
    const h = buildService();
    h.prisma.serviceOrder.findUnique.mockResolvedValue({
      startedAt: new Date('2026-08-24T10:00:00Z'), completedAt: null, status: 'WAITING_PARTS',
    });
    h.prisma.serviceOrderPause.findMany.mockResolvedValue([
      // Two closed parts waits (30m + 60m) and one closed ordinary pause (15m)
      { startedAt: new Date('2026-08-24T10:30:00Z'), endedAt: new Date('2026-08-24T11:00:00Z'), reasonCode: 'WAITING_PARTS', notes: null },
      { startedAt: new Date('2026-08-24T12:00:00Z'), endedAt: new Date('2026-08-24T13:00:00Z'), reasonCode: 'WAITING_PARTS', notes: null },
      { startedAt: new Date('2026-08-24T13:30:00Z'), endedAt: new Date('2026-08-24T13:45:00Z'), reasonCode: 'BREAK_OR_END_OF_DAY', notes: null },
      // Open parts wait right now
      { startedAt: new Date('2026-08-24T14:00:00Z'), endedAt: null, reasonCode: 'WAITING_PARTS', notes: 'caliper on backorder' },
    ]);

    const t = await h.service.getWorkTiming('so-1');
    expect(t.pausedMs).toBe(105 * 60000); // 30 + 60 + 15 closed minutes
    expect(t.waitingPartsMs).toBe(90 * 60000); // parts-only share
    expect(t.openPauseReason).toBe('WAITING_PARTS');
    expect(t.openPauseNotes).toBe('caliper on backorder');
  });
});
