import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-087 — a technician may not pass the quality check on their own work.
 *
 * Before this, passing QC was an ordinary status transition available to anyone
 * holding `service_order:status` — which technicians hold — and nothing recorded
 * who did it. So the person who built the job could sign it off, and afterwards
 * there was no way to tell who had. (A FAILED check was already attributed, via
 * ServiceOrderRework.openedByUserId; only the passing case was blind.)
 */
function buildService(opts: { techId?: string | null; hasOwnAssignment?: boolean } = {}) {
  const { techId = null, hasOwnAssignment = false } = opts;

  const prisma: any = {
    serviceOrder: { update: vi.fn(async ({ data }: any) => ({ id: 'so-1', ...data })) },
    serviceVisit: { update: vi.fn(async () => ({})) },
    queueTicket: {
      findUnique: vi.fn(async () => ({ id: 'qt-1', displayStatus: 'IN_SERVICE' })),
      update: vi.fn(async () => ({})),
    },
    technician: {
      findUnique: vi.fn(async () => (techId ? { id: techId } : null)),
    },
    technicianAssignment: {
      findFirst: vi.fn(async () => (hasOwnAssignment ? { id: 'ta-1' } : null)),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));

  const service = new ServiceOrdersService(
    prisma as any,
    { record: vi.fn(async () => ({})) } as any,
    { log: vi.fn(async () => ({})) } as any,
    { recomputeQueue: vi.fn(async () => ({})) } as any,
    // CR-2026-088 - KPI hooks. Stubbed: these tests exercise the order state
    // machine, not the KPI framework, which has its own suite.
    {
      assertVehicleClassConfirmed: vi.fn(async () => undefined),
      openSnapshotOnStart: vi.fn(async () => undefined),
      captureSnapshotOnQc: vi.fn(async () => undefined),
      reevaluatePackage: vi.fn(async () => undefined),
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
  vi.spyOn(service as any, 'triggerQueueRecompute').mockResolvedValue(undefined);

  return { service, prisma };
}

const qcOrder = () => ({
  id: 'so-1',
  status: 'QC',
  serviceVisitId: 'sv-1',
  serviceVisit: { id: 'sv-1', status: 'QC', siteId: 'site-1' },
});

const passQc = (s: ServiceOrdersService, userId: string) =>
  s.changeStatus('so-1', { toStatus: 'READY_TO_INVOICE' } as any, userId);

describe('CR-2026-087 — quality check cannot be self-approved', () => {
  let h: ReturnType<typeof buildService>;

  it('refuses when the actor worked on this order', async () => {
    h = buildService({ techId: 'tech-1', hasOwnAssignment: true });
    vi.spyOn(h.service, 'findById').mockResolvedValue(qcOrder() as any);

    await expect(passQc(h.service, 'user-tech-1')).rejects.toBeInstanceOf(ForbiddenException);
    // Nothing was written — the order stays in QC.
    expect(h.prisma.serviceOrder.update).not.toHaveBeenCalled();
  });

  it('explains why, rather than failing opaquely', async () => {
    h = buildService({ techId: 'tech-1', hasOwnAssignment: true });
    vi.spyOn(h.service, 'findById').mockResolvedValue(qcOrder() as any);

    await expect(passQc(h.service, 'user-tech-1')).rejects.toThrow(
      /cannot pass the quality check on work you carried out/i,
    );
  });

  it('allows a different technician to pass it', async () => {
    h = buildService({ techId: 'tech-2', hasOwnAssignment: false });
    vi.spyOn(h.service, 'findById').mockResolvedValue(qcOrder() as any);

    await passQc(h.service, 'user-tech-2');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalled();
  });

  it('allows a manager or advisor, who hold no technician record', async () => {
    h = buildService({ techId: null });
    vi.spyOn(h.service, 'findById').mockResolvedValue(qcOrder() as any);

    await passQc(h.service, 'user-manager');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalled();
    // No point querying assignments once we know the actor is not a technician.
    expect(h.prisma.technicianAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('records who passed the check and when', async () => {
    h = buildService({ techId: null });
    vi.spyOn(h.service, 'findById').mockResolvedValue(qcOrder() as any);

    await passQc(h.service, 'user-manager');

    const arg = h.prisma.serviceOrder.update.mock.calls[0][0];
    expect(arg.data.qcByUserId).toBe('user-manager');
    expect(arg.data.qcAt).toBeInstanceOf(Date);
  });

  it('checks ALL assignments, not just open ones', async () => {
    // Entry to QC ends the technician's assignment, so by the time anyone can pass
    // the check theirs is already closed. Filtering on endedAt: null would have made
    // the guard useless in exactly the case it exists for.
    h = buildService({ techId: 'tech-1', hasOwnAssignment: true });
    vi.spyOn(h.service, 'findById').mockResolvedValue(qcOrder() as any);

    await expect(passQc(h.service, 'user-tech-1')).rejects.toBeInstanceOf(ForbiddenException);

    const where = h.prisma.technicianAssignment.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ serviceOrderId: 'so-1', technicianId: 'tech-1' });
    expect(where).not.toHaveProperty('endedAt');
  });

  it('does not interfere with other transitions', async () => {
    h = buildService({ techId: 'tech-1', hasOwnAssignment: true });
    vi.spyOn(h.service, 'findById').mockResolvedValue({
      ...qcOrder(),
      status: 'IN_PROGRESS',
      serviceVisit: { id: 'sv-1', status: 'IN_SERVICE', siteId: 'site-1' },
    } as any);

    // The same technician sending their own work TO QC is normal and expected.
    await h.service.changeStatus('so-1', { toStatus: 'QC' } as any, 'user-tech-1');

    expect(h.prisma.serviceOrder.update).toHaveBeenCalled();
  });
});
