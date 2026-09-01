import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkSegmentService } from '../work-segment.service';

/**
 * CR-2026-090 — the work-segment lifecycle.
 *
 * These tests protect the properties that make a labour record believable: one open
 * segment per technician, a segment that never ends before it starts, work that stops
 * when the job stops, and corrections that cannot be made silently.
 */
function build(overrides: Record<string, any> = {}) {
  const store: any[] = [];

  const prisma: any = {
    technicianWorkSegment: {
      findFirst: vi.fn(async ({ where }: any) =>
        store.find(
          (s) =>
            // CR-2026-101 — the busy-elsewhere probe filters serviceOrderId: { not: X }.
            (typeof where.serviceOrderId === 'object' && where.serviceOrderId !== null
              ? s.serviceOrderId !== where.serviceOrderId.not
              : where.serviceOrderId === undefined || s.serviceOrderId === where.serviceOrderId) &&
            (where.technicianId === undefined || s.technicianId === where.technicianId) &&
            (where.endedAt !== null || s.endedAt === null) &&
            (where.id?.not === undefined || s.id !== where.id.not),
        ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        store.filter(
          (s) =>
            s.serviceOrderId === where.serviceOrderId &&
            (where.endedAt !== null || s.endedAt === null),
        ),
      ),
      findUnique: vi.fn(async ({ where }: any) => store.find((s) => s.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `seg-${store.length + 1}`, endedAt: null, ...data };
        store.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.find((s) => s.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    technicianAssignment: { findMany: vi.fn(async () => []) },
    kpiDelayEvent: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    ...overrides,
  };

  const audit = { log: vi.fn(async () => ({})) };
  return { service: new WorkSegmentService(prisma as any, audit as any), prisma, audit, store };
}

const start = (over: Record<string, any> = {}) => ({
  serviceOrderId: 'so-1',
  assignmentId: 'ta-1',
  technicianId: 'tech-1',
  actorUserId: 'user-1',
  ...over,
});

describe('starting a segment', () => {
  it('opens one and records who and why', async () => {
    const h = build();
    const seg = await h.service.startSegment(start());

    expect(seg.technicianId).toBe('tech-1');
    expect(seg.startSource).toBe('TECHNICIAN_START');
    expect(seg.roleSnapshot).toBe('PRIMARY');
    expect(seg.startedByUserId).toBe('user-1');
  });

  it('is idempotent — a retried Start does not fragment one period into two rows', async () => {
    // A double-tapped button or a client that fires on reconnect must not create a
    // second open segment, which would make "when did they start?" ambiguous.
    const h = build();
    const first = await h.service.startSegment(start());
    const second = await h.service.startSegment(start());

    expect(second.id).toBe(first.id);
    expect(h.store).toHaveLength(1);
  });

  it('lets a DIFFERENT technician open their own segment on the same job', async () => {
    const h = build();
    await h.service.startSegment(start());
    await h.service.startSegment(start({ technicianId: 'tech-2', assignmentId: 'ta-2' }));

    expect(h.store).toHaveLength(2);
  });

  it('snapshots an assisting role rather than assuming primary', async () => {
    const h = build();
    const seg = await h.service.startSegment(start({ role: 'ASSISTING' }));
    expect(seg.roleSnapshot).toBe('ASSISTING');
  });
});

describe('ending a segment', () => {
  it('closes the open segment with a stated reason', async () => {
    const h = build();
    await h.service.startSegment(start());
    const closed = await h.service.endSegment({
      serviceOrderId: 'so-1',
      technicianId: 'tech-1',
      endReason: 'SUBMITTED_TO_QC',
      actorUserId: 'user-1',
    });

    expect(closed?.endedAt).toBeInstanceOf(Date);
    expect(closed?.endReason).toBe('SUBMITTED_TO_QC');
  });

  it('returns null when there is nothing open, rather than throwing', async () => {
    // A technician submitting to QC on an already-paused job has no open segment.
    // Refusing their submission over that bookkeeping detail would block real work.
    const h = build();
    const closed = await h.service.endSegment({
      serviceOrderId: 'so-1',
      technicianId: 'tech-1',
      endReason: 'SUBMITTED_TO_QC',
      actorUserId: 'user-1',
    });
    expect(closed).toBeNull();
  });

  it('never ends a segment before it started', async () => {
    // Clock skew must not produce a negative labour figure — a credit for time
    // never worked.
    const h = build();
    await h.service.startSegment(start({ at: new Date('2026-08-21T10:00:00Z') }));
    const closed = await h.service.endSegment({
      serviceOrderId: 'so-1',
      technicianId: 'tech-1',
      endReason: 'SYSTEM_CLOSED',
      actorUserId: 'user-1',
      at: new Date('2026-08-21T09:00:00Z'),
    });

    expect(closed!.endedAt!.getTime()).toBe(closed!.startedAt.getTime());
  });

  it('closes every open segment when the whole job stops', async () => {
    const h = build();
    await h.service.startSegment(start());
    await h.service.startSegment(start({ technicianId: 'tech-2', assignmentId: 'ta-2' }));

    const count = await h.service.endAllForOrder({
      serviceOrderId: 'so-1',
      endReason: 'PAUSED',
      actorUserId: 'user-1',
    });

    expect(count).toBe(2);
    expect(h.store.every((s) => s.endedAt !== null)).toBe(true);
  });

  it('closing an order with nothing open is a no-op', async () => {
    const h = build();
    expect(
      await h.service.endAllForOrder({
        serviceOrderId: 'so-1',
        endReason: 'PAUSED',
        actorUserId: null,
      }),
    ).toBe(0);
  });
});

describe('resuming after a pause', () => {
  it('reopens segments only for technicians still assigned', async () => {
    // Someone taken off the job while it sat paused must not silently start
    // accruing labour again when a colleague resumes it.
    const h = build({
      technicianAssignment: {
        findMany: vi.fn(async () => [
          { id: 'ta-1', technicianId: 'tech-1', isPrimary: true },
          { id: 'ta-2', technicianId: 'tech-2', isPrimary: false },
        ]),
      },
    });

    const opened = await h.service.resumeForOrder({
      serviceOrderId: 'so-1',
      actorUserId: 'user-1',
    });

    expect(opened).toBe(2);
    expect(h.store.map((s) => s.startSource)).toEqual([
      'TECHNICIAN_RESUME',
      'TECHNICIAN_RESUME',
    ]);
    expect(h.store.map((s) => s.roleSnapshot)).toEqual(['PRIMARY', 'ASSISTING']);
  });

  it('reopens nothing when everyone has been taken off the job', async () => {
    const h = build();
    expect(
      await h.service.resumeForOrder({ serviceOrderId: 'so-1', actorUserId: 'user-1' }),
    ).toBe(0);
  });

  // CR-2026-101 — resuming a held job must never open a SECOND simultaneous
  // segment for a technician who is on the clock elsewhere. Same physics rule
  // as the start guard: one person, one open segment, however many jobs.
  it('skips a technician currently on the clock for another job', async () => {
    const h = build({
      technicianAssignment: {
        findMany: vi.fn(async () => [
          { id: 'ta-1', technicianId: 'tech-1', isPrimary: true },
          { id: 'ta-2', technicianId: 'tech-2', isPrimary: false },
        ]),
      },
    });
    // tech-1 is actively working ANOTHER order.
    await h.service.startSegment(start({ serviceOrderId: 'so-OTHER', assignmentId: 'ta-x' }));

    const opened = await h.service.resumeForOrder({ serviceOrderId: 'so-1', actorUserId: 'user-1' });

    // Only tech-2 reopens; tech-1 stays on their current job's clock.
    expect(opened).toBe(1);
    const so1Segs = h.store.filter((s) => s.serviceOrderId === 'so-1');
    expect(so1Segs).toHaveLength(1);
    expect(so1Segs[0].technicianId).toBe('tech-2');
    // tech-1 still has exactly ONE open segment — on the other job.
    const tech1Open = h.store.filter((s) => s.technicianId === 'tech-1' && s.endedAt === null);
    expect(tech1Open).toHaveLength(1);
    expect(tech1Open[0].serviceOrderId).toBe('so-OTHER');
  });
});

describe('reassignment', () => {
  it('closes the outgoing segment and opens the incoming one together', async () => {
    const h = build();
    await h.service.startSegment(start());

    const r = await h.service.reassign({
      serviceOrderId: 'so-1',
      fromTechnicianId: 'tech-1',
      toTechnicianId: 'tech-2',
      toAssignmentId: 'ta-2',
      actorUserId: 'user-1',
    });

    expect(r.closed?.endReason).toBe('REASSIGNED');
    expect(r.opened.startSource).toBe('REASSIGNMENT');
    expect(r.opened.roleSnapshot).toBe('REPLACEMENT');
    // Both halves in one transaction: never two people accruing at once, never nobody.
    expect(h.prisma.$transaction).toHaveBeenCalled();
  });

  it('hands over at a single instant, leaving no gap and no overlap', async () => {
    const h = build();
    const at = new Date('2026-08-21T10:00:00Z');
    await h.service.startSegment(start({ at: new Date('2026-08-21T09:00:00Z') }));
    const r = await h.service.reassign({
      serviceOrderId: 'so-1',
      fromTechnicianId: 'tech-1',
      toTechnicianId: 'tech-2',
      toAssignmentId: 'ta-2',
      actorUserId: 'user-1',
      at,
    });

    expect(r.closed!.endedAt!.getTime()).toBe(at.getTime());
    expect(r.opened.startedAt.getTime()).toBe(at.getTime());
  });
});

describe('manager correction', () => {
  it('refuses a correction with no reason', async () => {
    const h = build();
    await h.service.startSegment(start());
    await expect(
      h.service.correctSegment('seg-1', { reason: '  ' }, 'mgr-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an end before the start', async () => {
    const h = build();
    await h.service.startSegment(start({ at: new Date('2026-08-21T10:00:00Z') }));
    await expect(
      h.service.correctSegment(
        'seg-1',
        { endedAt: new Date('2026-08-21T09:00:00Z'), reason: 'typo' },
        'mgr-1',
      ),
    ).rejects.toThrow(/cannot end before it starts/i);
  });

  it('records the correction with an audit trail of before and after', async () => {
    const h = build();
    await h.service.startSegment(start({ at: new Date('2026-08-21T10:00:00Z') }));
    await h.service.correctSegment(
      'seg-1',
      { endedAt: new Date('2026-08-21T11:00:00Z'), reason: 'tech forgot to press stop' },
      'mgr-1',
    );

    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'KPI_WORK_SEGMENT_CORRECTED',
        actorUserId: 'mgr-1',
        notes: 'tech forgot to press stop',
      }),
    );
  });

  it('refuses to reopen a segment when another is already open for that technician', async () => {
    const h = build();
    await h.service.startSegment(start({ at: new Date('2026-08-21T09:00:00Z') }));
    await h.service.endSegment({
      serviceOrderId: 'so-1',
      technicianId: 'tech-1',
      endReason: 'PAUSED',
      actorUserId: 'user-1',
    });
    await h.service.startSegment(start({ at: new Date('2026-08-21T11:00:00Z') }));

    await expect(
      h.service.correctSegment('seg-1', { endedAt: null, reason: 'reopen' }, 'mgr-1'),
    ).rejects.toThrow(/already has an open segment/i);
  });

  it('refuses to correct a segment that does not exist', async () => {
    const h = build();
    await expect(
      h.service.correctSegment('nope', { reason: 'x' }, 'mgr-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
