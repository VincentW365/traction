import { describe, it, expect, vi } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-100 — Scenario B: switching work without double-counting labour.
 *
 * One person cannot productively work two jobs at once. Starting job B while
 * still on the clock for job A:
 *  - with no hold reason → 409 naming the active job (the UI prompts to switch);
 *  - with a hold reason and the technician the SOLE worker on A → A is held
 *    (paused with the stated reason) and B starts;
 *  - with colleagues still working A → only this technician's segment closes
 *    (SWITCHED_JOB) and A stays IN_PROGRESS.
 */

function build(opts: { openSegments?: any[]; colleaguesOnA?: number } = {}) {
  const prisma: any = {
    technicianAssignment: {
      findFirst: vi.fn(async () => ({ id: 'ta-B', technicianId: 'tech-1', status: 'ASSIGNED', isPrimary: true })),
      update: vi.fn(async ({ data }: any) => ({ id: 'ta-B', ...data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => [{ technicianId: 'tech-1', isPrimary: true }]),
    },
    technician: { findUnique: vi.fn(async () => ({ id: 'tech-1' })) },
    technicianWorkSegment: {
      findMany: vi.fn(async () => opts.openSegments ?? []),
      count: vi.fn(async () => opts.colleaguesOnA ?? 0),
    },
    serviceOrder: { findUnique: vi.fn(async () => ({ id: 'so-B', status: 'ASSIGNED' })) },
  };
  const auditService = { log: vi.fn(async () => ({})) };
  const segments = {
    startSegment: vi.fn(async () => ({ id: 'seg-B' })),
    endSegment: vi.fn(async () => ({ id: 'seg-A' })),
    endAllForOrder: vi.fn(async () => 1),
    resumeForOrder: vi.fn(async () => 1),
  };
  const service = new ServiceOrdersService(
    prisma as any,
    { record: vi.fn(async () => ({})) } as any,
    auditService as any,
    { recomputeQueue: vi.fn(async () => ({})) } as any,
    {
      assertVehicleClassConfirmed: vi.fn(async () => undefined),
      openSnapshotOnStart: vi.fn(async () => undefined),
    } as any,
    segments as any,
  );
  vi.spyOn(service as any, 'changeStatus').mockResolvedValue({});
  vi.spyOn(service as any, 'getBenchmarkReadiness').mockResolvedValue({ missingQualifiers: [] });
  return { service, prisma, segments, auditService };
}

const openSegmentOnA = {
  id: 'seg-A',
  serviceOrderId: 'so-A',
  serviceOrder: {
    status: 'IN_PROGRESS',
    serviceVisit: {
      vehicle: { plateNumber: 'AAA111' },
      queueTicket: { ticketNumber: 'B01-260901-001' },
    },
  },
};

describe('startAssignment — cross-job labour guard (CR-2026-100, Scenario B)', () => {
  it('starting with no open segment elsewhere proceeds normally', async () => {
    const h = build();
    await h.service.startAssignment('so-B', 'ta-B', 'user-1');
    expect(h.segments.startSegment).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: 'so-B', technicianId: 'tech-1' }),
    );
  });

  it('409s with the active job when the technician is still on the clock elsewhere', async () => {
    const h = build({ openSegments: [openSegmentOnA] });

    await expect(h.service.startAssignment('so-B', 'ta-B', 'user-1')).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'ACTIVE_WORK_ELSEWHERE',
        activeJobs: [expect.objectContaining({ orderId: 'so-A', plate: 'AAA111' })],
      }),
    });
    // Nothing started, nothing silently overlapping.
    expect(h.segments.startSegment).not.toHaveBeenCalled();
  });

  it('sole worker on A: holding with a reason pauses A (technician-attributed) then starts B', async () => {
    const h = build({ openSegments: [openSegmentOnA], colleaguesOnA: 0 });
    const pause = vi.spyOn(h.service, 'pause').mockResolvedValue({} as never);

    await h.service.startAssignment('so-B', 'ta-B', 'user-1', {
      holdReasonCode: 'WAITING_PARTS' as never,
      holdNotes: 'caliper on order',
    });

    // A is held through the real pause flow (first-class state + ledger + ack).
    expect(pause).toHaveBeenCalledWith(
      'so-A',
      expect.objectContaining({ reasonCode: 'WAITING_PARTS', notes: 'caliper on order' }),
      'user-1',
    );
    // The switch is audited and B starts.
    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WORK_SWITCHED', entityId: 'so-A' }),
    );
    expect(h.segments.startSegment).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: 'so-B' }),
    );
  });

  it("B's own start gates run BEFORE the switch: a refused start never holds A", async () => {
    // Live-validation catch: job B needed a brake qualifier, the start was
    // refused — but job A had already been put into WAITING_PARTS. The gates
    // now run first, so a start that cannot happen leaves everything untouched.
    const h = build({ openSegments: [openSegmentOnA], colleaguesOnA: 0 });
    const pause = vi.spyOn(h.service, 'pause').mockResolvedValue({} as never);
    (h.service as { getBenchmarkReadiness: unknown }).getBenchmarkReadiness = vi
      .fn()
      .mockResolvedValue({ missingQualifiers: [{ message: 'Choose the brake work type.' }] });

    await expect(
      h.service.startAssignment('so-B', 'ta-B', 'user-1', { holdReasonCode: 'WAITING_PARTS' as never }),
    ).rejects.toThrow(/brake work type/i);

    expect(pause).not.toHaveBeenCalled();
    expect(h.segments.endSegment).not.toHaveBeenCalled();
    expect(h.segments.startSegment).not.toHaveBeenCalled();
  });

  it('colleagues still working A: only this technician steps off — A keeps running', async () => {
    const h = build({ openSegments: [openSegmentOnA], colleaguesOnA: 2 });
    const pause = vi.spyOn(h.service, 'pause').mockResolvedValue({} as never);

    await h.service.startAssignment('so-B', 'ta-B', 'user-1', {
      holdReasonCode: 'OTHER' as never,
      holdNotes: 'switching to the quick job',
    });

    // A is NOT paused — others are working it.
    expect(pause).not.toHaveBeenCalled();
    // Only this technician's segment on A closes, honestly labelled.
    expect(h.segments.endSegment).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: 'so-A', technicianId: 'tech-1', endReason: 'SWITCHED_JOB' }),
    );
    expect(h.segments.startSegment).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: 'so-B' }),
    );
  });
});
