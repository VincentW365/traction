import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QueueService } from '../queue.service';

/**
 * CR-2026-018 (P3) — mark an active ServiceVisit as ABANDONED (no-show / left
 * before service). Verifies the terminal transition, audit/status-history
 * recording, queue recompute, and the guards (terminal ticket, historical
 * import, invalid visit status). Mocked PrismaService — no DB, no PII.
 */
function ticketRow(overrides: any = {}) {
  return {
    id: 'tkt-1',
    ticketNumber: 'A007',
    queueRank: 3,
    displayStatus: 'WAITING',
    serviceVisitId: 'sv-1',
    serviceVisit: {
      id: 'sv-1',
      siteId: 'site-1',
      status: 'CHECKED_IN',
      sourceType: 'WALKIN',
      ...overrides.serviceVisit,
    },
    ...overrides,
  };
}

function buildService(ticket: any) {
  const tx: any = {
    serviceVisit: { update: vi.fn(async () => ({})) },
    queueTicket: { update: vi.fn(async () => ({})) },
    resourceOccupancy: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma: any = {
    queueTicket: { findUnique: vi.fn(async () => ticket) },
    queueEvent: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const auditService = { log: vi.fn(async () => ({})) };
  const schedulingService = { recomputeQueue: vi.fn(async () => undefined) };
  const statusHistory = { record: vi.fn(async () => ({})) };

  const service = new QueueService(
    prisma as any,
    auditService as any,
    schedulingService as any,
    statusHistory as any,
  );
  return { service, prisma, tx, auditService, schedulingService, statusHistory };
}

describe('QueueService.abandonVisit (CR-2026-018, P3)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => {
    h = buildService(ticketRow());
  });

  it('marks an active visit ABANDONED and closes its queue ticket', async () => {
    const res = await h.service.abandonVisit('tkt-1', { reasonCode: 'NO_SHOW' }, 'user-1');

    expect(h.tx.serviceVisit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sv-1' }, data: { status: 'ABANDONED' } }),
    );
    expect(h.tx.queueTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tkt-1' }, data: { displayStatus: 'CANCELLED' } }),
    );
    // Resource released so a freed bay is not left occupied.
    expect(h.tx.resourceOccupancy.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serviceVisitId: 'sv-1', status: 'OCCUPIED' } }),
    );
    expect(res).toMatchObject({ status: 'ABANDONED', serviceVisitId: 'sv-1' });
  });

  it('records a StatusHistory transition to ABANDONED with actor + reason', async () => {
    await h.service.abandonVisit('tkt-1', { reasonCode: 'LEFT_BEFORE_SERVICE', notes: 'waited 40m' }, 'user-1');

    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'ServiceVisit',
        entityId: 'sv-1',
        fromStatus: 'CHECKED_IN',
        toStatus: 'ABANDONED',
        changedByUserId: 'user-1',
        reasonCode: 'LEFT_BEFORE_SERVICE',
        notes: 'waited 40m',
      }),
    );
  });

  it('writes an AuditLog with the SERVICE_VISIT_ABANDONED action and before/after', async () => {
    await h.service.abandonVisit('tkt-1', { reasonCode: 'NO_SHOW' }, 'user-1');

    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'SERVICE_VISIT_ABANDONED',
        entityType: 'ServiceVisit',
        entityId: 'sv-1',
        beforeJson: { status: 'CHECKED_IN', displayStatus: 'WAITING' },
        afterJson: { status: 'ABANDONED', displayStatus: 'CANCELLED' },
        reasonCode: 'NO_SHOW',
      }),
    );
  });

  it('triggers a queue recompute for the affected site', async () => {
    await h.service.abandonVisit('tkt-1', { reasonCode: 'NO_SHOW' }, 'user-1');
    expect(h.schedulingService.recomputeQueue).toHaveBeenCalledWith('site-1');
  });

  it('logs an ABANDONED queue event', async () => {
    await h.service.abandonVisit('tkt-1', { reasonCode: 'NO_SHOW' }, 'user-1');
    expect(h.prisma.queueEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serviceVisitId: 'sv-1',
          queueTicketId: 'tkt-1',
          eventType: 'ABANDONED',
          reasonCode: 'NO_SHOW',
        }),
      }),
    );
  });

  it('throws NotFound when the ticket does not exist', async () => {
    const g = buildService(null);
    await expect(g.service.abandonVisit('missing', { reasonCode: 'NO_SHOW' }, 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects abandoning a ticket already in a terminal display state', async () => {
    const g = buildService(ticketRow({ displayStatus: 'COMPLETED' }));
    await expect(g.service.abandonVisit('tkt-1', { reasonCode: 'NO_SHOW' }, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(g.schedulingService.recomputeQueue).not.toHaveBeenCalled();
  });

  it('refuses to abandon an imported historical visit', async () => {
    const g = buildService(ticketRow({ serviceVisit: { id: 'sv-1', siteId: 'site-1', status: 'CHECKED_IN', sourceType: 'HISTORICAL_IMPORT' } }));
    await expect(g.service.abandonVisit('tkt-1', { reasonCode: 'NO_SHOW' }, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(g.tx.serviceVisit.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid visit-status transition (e.g. READY_FOR_PICKUP)', async () => {
    const g = buildService(ticketRow({ serviceVisit: { id: 'sv-1', siteId: 'site-1', status: 'READY_FOR_PICKUP', sourceType: 'WALKIN' } }));
    await expect(g.service.abandonVisit('tkt-1', { reasonCode: 'NO_SHOW' }, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(g.schedulingService.recomputeQueue).not.toHaveBeenCalled();
  });
});
