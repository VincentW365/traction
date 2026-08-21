import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-084 — the ServiceOrder → QueueTicket status sync.
 *
 * Nothing in production code ever wrote `IN_SERVICE` to a queue ticket. Starting
 * work updated the order and the visit but left the ticket reading WAITING/CALLED,
 * which is why the queue board never showed a job as started, the customer's status
 * link stayed on "in queue" while the car was on the lift, and the technician's own
 * card disappeared. These tests pin that write down.
 */
function buildService() {
  const prisma: any = {
    serviceOrder: { update: vi.fn(async ({ data }: any) => ({ id: 'so-1', ...data })) },
    serviceVisit: { update: vi.fn(async () => ({})) },
    technicianAssignment: { updateMany: vi.fn(async () => ({ count: 0 })) },
    queueTicket: {
      findUnique: vi.fn(async () => ({ id: 'qt-1', displayStatus: 'WAITING' })),
      update: vi.fn(async () => ({})),
    },
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));

  const statusHistory = { record: vi.fn(async () => ({})) };
  const auditService = { log: vi.fn(async () => ({})) };
  const schedulingService = { recomputeQueue: vi.fn(async () => ({})) };

  const service = new ServiceOrdersService(
    prisma as any,
    statusHistory as any,
    auditService as any,
    schedulingService as any,
    // CR-2026-088 - KPI hooks. Stubbed: these tests exercise the order state
    // machine, not the KPI framework, which has its own suite.
    { assertVehicleClassConfirmed: vi.fn(async () => undefined), captureSnapshotOnQc: vi.fn(async () => undefined) } as any,
  );
  vi.spyOn(service as any, 'triggerQueueRecompute').mockResolvedValue(undefined);

  return { service, prisma };
}

const order = (status: string) => ({
  id: 'so-1',
  status,
  serviceVisitId: 'sv-1',
  serviceVisit: { id: 'sv-1', status: 'CHECKED_IN', siteId: 'site-1' },
});

describe('CR-2026-084 — QueueTicket stays in step with the work', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  it('starting work marks the ticket IN_SERVICE and surrenders its queue position', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('ASSIGNED') as any);

    await h.service.changeStatus('so-1', { toStatus: 'IN_PROGRESS' } as any, 'user-1');

    expect(h.prisma.queueTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'qt-1' },
        data: expect.objectContaining({
          displayStatus: 'IN_SERVICE',
          // A car on the lift is not waiting in line; a stale rank collided with
          // the positions handed to the tickets still queued.
          queueRank: null,
          readyForDispatch: false,
        }),
      }),
    );
  });

  it('also syncs the visit, so the customer status link advances', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('ASSIGNED') as any);

    await h.service.changeStatus('so-1', { toStatus: 'IN_PROGRESS' } as any, 'user-1');

    expect(h.prisma.serviceVisit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_SERVICE' }) }),
    );
  });

  it('never resurrects a ticket that was already closed out', async () => {
    h.prisma.queueTicket.findUnique.mockResolvedValueOnce({ id: 'qt-1', displayStatus: 'COMPLETED' });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('ASSIGNED') as any);

    await h.service.changeStatus('so-1', { toStatus: 'IN_PROGRESS' } as any, 'user-1');

    expect(h.prisma.queueTicket.update).not.toHaveBeenCalled();
  });

  it('does not rewrite a ticket that is already in the target state', async () => {
    h.prisma.queueTicket.findUnique.mockResolvedValueOnce({ id: 'qt-1', displayStatus: 'IN_SERVICE' });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);

    await h.service.changeStatus('so-1', { toStatus: 'QC' } as any, 'user-1');

    expect(h.prisma.queueTicket.update).not.toHaveBeenCalled();
  });

  it('leaves the ticket alone for statuses that have no queue meaning', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);

    await h.service.changeStatus('so-1', { toStatus: 'WAITING_PARTS' } as any, 'user-1');

    // Parts blocking is the scheduler's job, driven by parts readiness — not a
    // display-status write from here.
    expect(h.prisma.queueTicket.update).not.toHaveBeenCalled();
  });
});
