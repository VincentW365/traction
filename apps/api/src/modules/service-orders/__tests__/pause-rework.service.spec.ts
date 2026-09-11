import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * Recording-only pause/resume/rework (CR-2026-001).
 * Verifies the new transitions, ledger writes, and that pause/resume never touch the
 * ServiceVisit status. CR-2026-105b took the decision deferred in docs/25: a pause or
 * resume DOES trigger a recompute — never to change rank (an in-service ticket has
 * none) but to republish the authoritative estimate with the clock held.
 */
function buildService() {
  const prisma: any = {
    serviceOrder: (() => { let last = 'IN_PROGRESS'; return { update: vi.fn(async ({ data }: any) => { if (data.status) last = data.status; return { id: 'so-1', ...data }; }), findMany: vi.fn(async () => [{ status: last }]) }; })(),
    serviceOrderPause: { create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    serviceOrderRework: { count: vi.fn(async () => 0), create: vi.fn(async () => ({})) },
    serviceVisit: { update: vi.fn(async () => ({})) },
    // CR-2026-084 — rework now also ends any open assignment and returns the
    // queue ticket to the waiting line.
    technicianAssignment: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      // CR-2026-100 — pause attribution reads the open assignments.
      findMany: vi.fn(async () => []),
    },
    // CR-2026-100 — attribution: null = staff actor (self-acknowledged pause).
    technician: { findUnique: vi.fn(async () => null) },
    queueTicket: {
      findUnique: vi.fn(async () => ({ id: 'qt-1', displayStatus: 'IN_SERVICE' })),
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
    {
      assertVehicleClassConfirmed: vi.fn(async () => undefined),
      openSnapshotOnStart: vi.fn(async () => undefined),
      captureSnapshotOnQc: vi.fn(async () => undefined),
      reevaluatePackage: vi.fn(async () => undefined),
      // CR-2026-092 - the pre-start benchmark-readiness check. Stubbed as "nothing
      // missing"; the calculation has its own suite.
      calculateStandardForOrder: vi.fn(async () => ({
        missingQualifiers: [],
        unmappedServiceTypeIds: [],
        finalStandardMinutes: 90,
        benchmarkSource: 'MANAGER_PACKAGE',
      })),
      getCalculationBreakdown: vi.fn(async () => ({
        vehicleClass: 'SEDAN_CLASS',
        breakdown: { finalStandardMinutes: 90, lines: [] },
      })),
    } as any,
    // CR-2026-090 - work-segment hooks. Stubbed for the same reason: these tests
    // exercise the order state machine, and segments have their own suite.
    {
      startSegment: vi.fn(async () => ({ id: 'seg-1' })),
      endSegment: vi.fn(async () => null),
      endAllForOrder: vi.fn(async () => 0),
      resumeForOrder: vi.fn(async () => 0),
    } as any,
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

  it('pause does NOT change the visit status, but DOES republish the estimate (CR-2026-105b)', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);
    await h.service.pause('so-1', { reasonCode: 'OTHER' } as any, 'user-1');

    expect(h.prisma.serviceVisit.update).not.toHaveBeenCalled();
    // The recompute republishes the ETA (clock held → DELAYED on every board); the
    // ranker itself sees no change because an in-service ticket carries no rank.
    expect(h.recompute).toHaveBeenCalledWith('site-1');
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
    // CR-2026-105b — the clock runs again, so the estimate is republished.
    expect(h.recompute).toHaveBeenCalledWith('site-1');
  });

  it('rejects resuming an order that is not PAUSED', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);
    await expect(h.service.resume('so-1', {} as any, 'user-1')).rejects.toThrow();
  });

  // --- REWORK --------------------------------------------------------------
  /**
   * CR-2026-084 — rework returns the order to APPROVED, not IN_PROGRESS.
   *
   * Sending work to QC already ends the technician's assignment, so the old
   * behaviour left the order reading "in progress" with nobody assigned to it and
   * no way for any technician to pick it up. A failed QC now puts the job back in
   * the queue to be assigned again like any other work.
   */
  it('opens rework from QC: returns to APPROVED for reassignment, clears timestamps, records a rework row', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('QC') as any);
    await h.service.openRework('so-1', { reasonCode: 'QC_FAIL_BRAKES', description: 'pads not seated' } as any, 'user-1');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'APPROVED', completedAt: null, startedAt: null } }),
    );
    expect(h.prisma.serviceOrderRework.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'QC_FAIL_BRAKES', reworkCount: 1 }) }),
    );
    // No open assignment may survive an order going back out for assignment.
    expect(h.prisma.technicianAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ serviceOrderId: 'so-1', endedAt: null }),
      }),
    );
    // The car rejoins the queue rather than staying "in service".
    expect(h.prisma.serviceVisit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'QUEUED' }) }),
    );
    expect(h.recompute).toHaveBeenCalledWith('site-1');
  });

  it('rework puts the queue ticket back in the waiting line', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('QC') as any);
    await h.service.openRework('so-1', { reasonCode: 'QC_FAIL_BRAKES' } as any, 'user-1');

    expect(h.prisma.queueTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ displayStatus: 'WAITING' }) }),
    );
  });

  it('rejects rework when the order is not in QC', async () => {
    vi.spyOn(h.service, 'findById').mockResolvedValue(order('IN_PROGRESS') as any);
    await expect(
      h.service.openRework('so-1', { reasonCode: 'X' } as any, 'user-1'),
    ).rejects.toThrow();
  });
});
