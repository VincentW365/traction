import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueService } from '../queue.service';

/**
 * CR-2026-078 — final "Picked Up" close-out: close the visit, complete its ticket,
 * free any bay, and recompute (idempotent).
 */
function build(visit: any) {
  const tx: any = {
    serviceVisit: { update: vi.fn(async () => ({})) },
    queueTicket: { update: vi.fn(async () => ({})) },
    resourceOccupancy: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma: any = {
    serviceVisit: { findUnique: vi.fn(async () => visit) },
    queueEvent: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const auditService = { log: vi.fn(async () => ({})) };
  const schedulingService = { recomputeQueue: vi.fn(async () => undefined) };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const service = new QueueService(prisma as any, auditService as any, schedulingService as any, statusHistory as any);
  return { service, prisma, tx, schedulingService };
}

const visitRow = (overrides: any = {}) => ({
  id: 'sv-1',
  siteId: 'site-1',
  status: 'READY_FOR_PICKUP',
  queueTicket: { id: 'tkt-1', displayStatus: 'IN_SERVICE' },
  ...overrides,
});

describe('QueueService.markPickedUp (CR-2026-078)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('closes the visit, completes the ticket, frees the bay, and recomputes', async () => {
    const h = build(visitRow());
    const res = await h.service.markPickedUp('sv-1', 'user-1');

    expect(h.tx.serviceVisit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sv-1' }, data: { status: 'CLOSED' } }),
    );
    expect(h.tx.queueTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tkt-1' }, data: { displayStatus: 'COMPLETED' } }),
    );
    expect(h.tx.resourceOccupancy.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serviceVisitId: 'sv-1', status: 'OCCUPIED' } }),
    );
    expect(h.prisma.queueEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'PICKED_UP' }) }),
    );
    expect(h.schedulingService.recomputeQueue).toHaveBeenCalledWith('site-1');
    expect(res).toMatchObject({ serviceVisitId: 'sv-1' });
    expect(res.message).toMatch(/picked up/i);
  });

  it('is idempotent — a already-closed visit does nothing', async () => {
    const h = build(visitRow({ status: 'CLOSED' }));
    const res = await h.service.markPickedUp('sv-1', 'user-1');
    expect(res.message).toMatch(/already closed/i);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.schedulingService.recomputeQueue).not.toHaveBeenCalled();
  });

  it('404s when the visit does not exist', async () => {
    const h = build(null);
    await expect(h.service.markPickedUp('missing', 'user-1')).rejects.toThrow(/not found/i);
  });
});
