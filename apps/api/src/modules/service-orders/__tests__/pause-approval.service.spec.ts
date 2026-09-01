import { describe, it, expect, vi } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-100 — the pause acknowledgement workflow.
 *
 * Scenario C: technician pauses at 10:42, advisor approves at 10:49 → the pause
 *             is effective from 10:42. Approval never moves the clock.
 * Scenario D: the technician forgot — an advisor records the pause on their
 *             behalf; history identifies the advisor as the actor and the
 *             technician as the assigned worker.
 * Scenario E: a controlled retroactive correction moves the effective start
 *             EARLIER, requires a reason, preserves the original, trims labour.
 */

function build(overrides: any = {}) {
  const prisma: any = {
    serviceOrder: (() => {
      let last = 'IN_PROGRESS';
      return {
        update: vi.fn(async ({ data }: any) => {
          if (data.status) last = data.status;
          return { id: 'so-1', ...data, serviceVisit: { id: 'sv-1', siteId: 'site-1', status: 'IN_SERVICE' } };
        }),
        findUnique: vi.fn(async () => ({ id: 'so-1', status: 'IN_PROGRESS', startedAt: new Date('2026-09-01T09:00:00Z') })),
        findMany: vi.fn(async () => [{ status: last }]),
      };
    })(),
    serviceOrderPause: {
      create: vi.fn(async ({ data }: any) => ({ id: 'p-1', ...data })),
      update: vi.fn(async ({ data }: any) => ({ id: 'p-1', ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    serviceVisit: { update: vi.fn(async () => ({})) },
    technicianAssignment: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => [{ technicianId: 'tech-1', isPrimary: true }]),
    },
    technician: { findUnique: vi.fn(async () => null) },
    technicianWorkSegment: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    queueTicket: {
      findUnique: vi.fn(async () => ({ id: 'qt-1', displayStatus: 'IN_SERVICE' })),
      update: vi.fn(async () => ({})),
    },
    ...overrides,
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));

  const statusHistory = { record: vi.fn(async () => ({})) };
  const auditService = { log: vi.fn(async () => ({})) };
  const segments = {
    startSegment: vi.fn(async () => ({ id: 'seg-1' })),
    endSegment: vi.fn(async () => null),
    endAllForOrder: vi.fn(async () => 1),
    resumeForOrder: vi.fn(async () => 1),
    correctSegment: vi.fn(async () => ({ id: 'seg-1' })),
  };
  const service = new ServiceOrdersService(
    prisma as any,
    statusHistory as any,
    auditService as any,
    { recomputeQueue: vi.fn(async () => ({})) } as any,
    { assertVehicleClassConfirmed: vi.fn(async () => undefined), openSnapshotOnStart: vi.fn(async () => undefined), captureSnapshotOnQc: vi.fn(async () => undefined) } as any,
    segments as any,
  );
  vi.spyOn(service as any, 'triggerQueueRecompute').mockResolvedValue(undefined);
  return { service, prisma, auditService, segments, statusHistory };
}

const orderIn = (status: string) => ({
  id: 'so-1',
  status,
  serviceVisitId: 'sv-1',
  serviceVisit: { id: 'sv-1', siteId: 'site-1', status: 'IN_SERVICE' },
});

describe('pause attribution (CR-2026-100)', () => {
  it("the assigned technician's own pause is PENDING acknowledgement, attributed to them", async () => {
    const h = build({
      technician: { findUnique: vi.fn(async () => ({ id: 'tech-1' })) },
    });
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('IN_PROGRESS') as never);

    await h.service.pause('so-1', { reasonCode: 'WAITING_PARTS', notes: 'pads on order' } as never, 'user-tech-1');

    expect(h.prisma.serviceOrderPause.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          technicianId: 'tech-1',
          enteredOnBehalf: false,
          approvalStatus: 'PENDING',
          reviewedByUserId: null,
        }),
      }),
    );
  });

  it('an advisor recording the pause is APPROVED immediately and marked on-behalf (Scenario D)', async () => {
    const h = build(); // technician.findUnique → null: a staff actor
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('IN_PROGRESS') as never);

    await h.service.pause('so-1', { reasonCode: 'WAITING_PARTS', notes: 'tech reported verbally' } as never, 'user-advisor-1');

    // Recorded against the assigned technician, entered by someone else,
    // self-acknowledged by the recording advisor.
    expect(h.prisma.serviceOrderPause.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          technicianId: 'tech-1',
          enteredOnBehalf: true,
          approvalStatus: 'APPROVED',
          reviewedByUserId: 'user-advisor-1',
          pausedByUserId: 'user-advisor-1',
        }),
      }),
    );
    // And the on-behalf fact is audited — it must never look like the
    // technician pressed the button.
    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAUSE_RECORDED_ON_BEHALF', actorUserId: 'user-advisor-1' }),
    );
  });
});

describe('approve / reject (CR-2026-100)', () => {
  const pendingPause = {
    id: 'p-1',
    serviceOrderId: 'so-1',
    reasonCode: 'WAITING_PARTS',
    startedAt: new Date('2026-09-01T10:42:00Z'),
    endedAt: null,
    approvalStatus: 'PENDING',
    originalStartedAt: null,
  };

  it('approval records who and when but NEVER moves the effective start (Scenario C)', async () => {
    const h = build({
      serviceOrderPause: {
        findFirst: vi.fn(async () => pendingPause),
        update: vi.fn(async ({ data }: any) => ({ ...pendingPause, ...data })),
        create: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
    });

    await h.service.approvePause('so-1', 'p-1', 'user-advisor-1');

    const updateArgs = (h.prisma.serviceOrderPause.update.mock.calls as any[])[0][0];
    expect(updateArgs.data).toMatchObject({ approvalStatus: 'APPROVED', reviewedByUserId: 'user-advisor-1' });
    // startedAt is untouched — 10:42 stays 10:42 no matter when the advisor acted.
    expect(updateArgs.data).not.toHaveProperty('startedAt');
    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAUSE_APPROVED', entityId: 'p-1' }),
    );
  });

  it('rejection requires a reason', async () => {
    const h = build();
    await expect(h.service.rejectPause('so-1', 'p-1', '   ', 'user-1')).rejects.toThrow(/reason/i);
  });

  it('rejection keeps the original request, records the reason, and resumes the stopped work', async () => {
    const h = build({
      serviceOrderPause: {
        findFirst: vi.fn(async () => pendingPause),
        update: vi.fn(async ({ data }: any) => ({ ...pendingPause, ...data })),
        create: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
    });
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('WAITING_PARTS') as never);
    const resume = vi.spyOn(h.service, 'resume').mockResolvedValue({} as never);

    await h.service.rejectPause('so-1', 'p-1', 'Parts are on the shelf — check bin 4', 'user-advisor-1');

    // Marked REJECTED with the reason — never deleted.
    expect(h.prisma.serviceOrderPause.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalStatus: 'REJECTED',
          reviewNotes: 'Parts are on the shelf — check bin 4',
        }),
      }),
    );
    // The stopped job resumes (the interval closes at rejection — work genuinely was stopped until then).
    expect(resume).toHaveBeenCalledWith('so-1', expect.anything(), 'user-advisor-1');
    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAUSE_REJECTED' }),
    );
  });

  it('a pause already reviewed cannot be re-reviewed', async () => {
    const h = build({
      serviceOrderPause: {
        findFirst: vi.fn(async () => ({ ...pendingPause, approvalStatus: 'APPROVED' })),
        update: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
        findMany: vi.fn(async () => []),
      },
    });
    await expect(h.service.approvePause('so-1', 'p-1', 'user-1')).rejects.toThrow(/already been reviewed/i);
  });
});

describe('retroactive correction (Scenario E)', () => {
  const recorded = new Date('2026-09-01T11:20:00Z');
  const trueStop = '2026-09-01T11:05:00Z';
  const pause = {
    id: 'p-1',
    serviceOrderId: 'so-1',
    reasonCode: 'WAITING_PARTS',
    startedAt: recorded,
    endedAt: null,
    approvalStatus: 'APPROVED',
    originalStartedAt: null,
  };

  function buildCorrection() {
    return build({
      serviceOrderPause: {
        findFirst: vi.fn(async () => pause),
        update: vi.fn(async ({ data }: any) => ({ ...pause, ...data })),
        create: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
      technicianWorkSegment: {
        findMany: vi.fn(async () => [
          // The segment this pause closed — ended at the recorded press time.
          { id: 'seg-1', startedAt: new Date('2026-09-01T09:00:00Z') },
        ]),
        count: vi.fn(async () => 0),
      },
    });
  }

  it('requires a reason', async () => {
    const h = buildCorrection();
    await expect(
      h.service.correctPauseStart('so-1', 'p-1', { effectiveFrom: trueStop, reason: '' }, 'user-1'),
    ).rejects.toThrow(/reason/i);
  });

  it('moves the effective start earlier, preserves the original, audits, and trims labour', async () => {
    const h = buildCorrection();

    await h.service.correctPauseStart(
      'so-1',
      'p-1',
      { effectiveFrom: trueStop, reason: 'Technician reported stopping at 11:05' },
      'user-advisor-1',
    );

    // The row: new effective start, ORIGINAL preserved, correction attributed.
    expect(h.prisma.serviceOrderPause.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          startedAt: new Date(trueStop),
          originalStartedAt: recorded,
          correctedByUserId: 'user-advisor-1',
          correctionReason: 'Technician reported stopping at 11:05',
        }),
      }),
    );
    // Audited with before/after.
    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAUSE_TIME_CORRECTED',
        beforeJson: { startedAt: recorded },
        afterJson: { startedAt: new Date(trueStop) },
      }),
    );
    // The labour segment that ran to 11:20 is trimmed to 11:05 through the
    // audited segment-correction path.
    expect(h.segments.correctSegment).toHaveBeenCalledWith(
      'seg-1',
      expect.objectContaining({ endedAt: new Date(trueStop) }),
      'user-advisor-1',
    );
  });

  it('refuses to move the effective start LATER than the recorded press', async () => {
    const h = buildCorrection();
    await expect(
      h.service.correctPauseStart(
        'so-1',
        'p-1',
        { effectiveFrom: '2026-09-01T11:30:00Z', reason: 'nope' },
        'user-1',
      ),
    ).rejects.toThrow(/earlier/i);
  });

  it('refuses a pause earlier than the start of work', async () => {
    const h = buildCorrection();
    await expect(
      h.service.correctPauseStart(
        'so-1',
        'p-1',
        { effectiveFrom: '2026-09-01T08:00:00Z', reason: 'before work even began' },
        'user-1',
      ),
    ).rejects.toThrow(/before work started/i);
  });
});
