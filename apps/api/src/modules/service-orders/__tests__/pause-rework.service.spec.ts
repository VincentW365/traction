import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * Recording-only pause/resume/rework (CR-2026-001).
 * Verifies the new transitions, ledger writes, and — critically — that pause/resume
 * do NOT touch the ServiceVisit status or trigger a queue recompute (no scheduling impact).
 */
function buildService() {
  const prisma: any = {
    serviceOrder: { update: vi.fn(async ({ data }: any) => ({ id: 'so-1', ...data })) },
    serviceOrderPause: { create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    serviceOrderRework: { count: vi.fn(async () => 0), create: vi.fn(async () => ({})) },
    serviceVisit: { update: vi.fn(async () => ({})) },
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
  );
  // Neutralize the private recompute helper so we can assert it independently.
  const recompute = vi.spyOn(service as any, 'triggerQueueRecompute').mockResolvedValue(undefined);

  return { service, prisma, statusHistory, recompute };
}

function order(status: string) {
  return {
    id: 'so-1',
    status,
    serviceVisitId: 'sv-1',
    serviceVisit: { id: 'sv-1', status: 'IN_SERVICE', siteId: 'site-1' },
  };
}

describe('ServiceOrder pause/resume/rework (CR-2026-001, recording-only)', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => { h = buildService(); });

  // --- PAUSE ---------------------------------------------------------------
  it('pauses an IN_PROGRESS order: sets PAUSED, opens a pause row, records history', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);
    await h.service.pause('so-1', { reasonCode: 'WAITING_TECH' } as any, 'user-1');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PAUSED' } }),
    );
    expect(h.prisma.serviceOrderPause.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'WAITING_TECH', pausedByUserId: 'user-1' }) }),
    );
    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'ServiceOrder', toStatus: 'PAUSED' }),
    );
  });

  it('pause does NOT change the visit status or recompute the queue (no scheduling impact)', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);
    await h.service.pause('so-1', { reasonCode: 'OTHER' } as any, 'user-1');

    expect(h.prisma.serviceVisit.update).not.toHaveBeenCalled();
    expect(h.recompute).not.toHaveBeenCalled();
  });

  it('rejects pausing an order that is not IN_PROGRESS', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('QC') as any);
    await expect(h.service.pause('so-1', { reasonCode: 'OTHER' } as any, 'user-1')).rejects.toThrow();
  });

  // --- RESUME --------------------------------------------------------------
  it('resumes a PAUSED order: sets IN_PROGRESS and closes the open pause interval', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('PAUSED') as any);
    await h.service.resume('so-1', {} as any, 'user-1');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'IN_PROGRESS' } }),
    );
    expect(h.prisma.serviceOrderPause.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { serviceOrderId: 'so-1', endedAt: null },
        data: expect.objectContaining({ resumedByUserId: 'user-1' }),
      }),
    );
    expect(h.prisma.serviceVisit.update).not.toHaveBeenCalled();
    expect(h.recompute).not.toHaveBeenCalled();
  });

  it('rejects resuming an order that is not PAUSED', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);
    await expect(h.service.resume('so-1', {} as any, 'user-1')).rejects.toThrow();
  });

  // --- REWORK --------------------------------------------------------------
  it('opens rework from QC: returns to IN_PROGRESS, clears completedAt, records a rework row', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('QC') as any);
    await h.service.openRework('so-1', { reasonCode: 'QC_FAIL_BRAKES', description: 'pads not seated' } as any, 'user-1');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'IN_PROGRESS', completedAt: null } }),
    );
    expect(h.prisma.serviceOrderRework.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'QC_FAIL_BRAKES', reworkCount: 1 }) }),
    );
    // Rework reuses existing IN_PROGRESS semantics: visit re-syncs and queue recomputes.
    expect(h.prisma.serviceVisit.update).toHaveBeenCalled();
    expect(h.recompute).toHaveBeenCalledWith('site-1');
  });

  it('rejects rework when the order is not in QC', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);
    await expect(
      h.service.openRework('so-1', { reasonCode: 'X' } as any, 'user-1'),
    ).rejects.toThrow();
  });
});
