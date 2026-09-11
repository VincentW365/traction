import { describe, it, expect, vi } from 'vitest';
import { SchedulingService } from '../scheduling.service';
import { EtaService } from '../eta/eta.service';

/**
 * CR-2026-105b — the ETA pass inside recomputeQueue: runs AFTER ranking, writes the
 * existing (previously unused) ETA columns, never touches the ranker's fields,
 * and a projection failure never stops the queue from being ranked.
 */

const T = (m: number) => new Date(Date.UTC(2026, 8, 11, 14, m));

function ticket(id: string, seq: number, estimate = 60) {
  return {
    id,
    serviceVisitId: `visit-${id}`,
    checkinSequence: seq,
    displayStatus: 'WAITING',
    overrideActive: false,
    overrideRankPosition: null,
    queueRank: null,
    serviceVisit: {
      siteId: 'site-1',
      status: 'QUEUED',
      queuePriorityClass: null,
      checkedInAt: T(-20 - seq),
      arrivalAt: T(-20 - seq),
      appointment: null,
      serviceOrders: [
        {
          items: [{ estimateMinutes: estimate, serviceType: { quickService: false, baseDurationMinutes: estimate, partsPrepositionRequired: false } }],
          partsRequests: [],
          reworks: [],
        },
      ],
    },
  };
}

function build(opts: { etaThrows?: boolean } = {}) {
  const tx = {
    queueTicket: { update: vi.fn(async () => ({})) },
    serviceVisit: { update: vi.fn(async () => ({})) },
    queueDecision: { create: vi.fn(async () => ({})) },
    resourceOccupancy: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma: any = {
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (cb: any) => cb(tx)),
    queueTicket: { findMany: vi.fn(async () => [ticket('a', 1), ticket('b', 2)]) },
    workResource: { findMany: vi.fn(async () => [{ id: 'r1', resourceCategory: 'BAY', maxVehicleWeight: null }]), aggregate: vi.fn() },
    businessRuleConfig: { findMany: vi.fn(async () => []) },
    serviceVisit: {
      findMany: vi.fn(async () => [
        {
          id: 'visit-busy',
          status: 'IN_SERVICE',
          serviceOrders: [
            { status: 'IN_PROGRESS', startedAt: T(-50), items: [{ estimateMinutes: 80, serviceType: { baseDurationMinutes: 80 } }], pauses: [], kpiSnapshot: null },
          ],
        },
      ]),
    },
  };
  const emitter = { emit: vi.fn() };
  const eta = new EtaService(prisma);
  if (opts.etaThrows) vi.spyOn(eta, 'loadRules').mockRejectedValue(new Error('boom'));
  const service = new SchedulingService(prisma, emitter as any, eta);
  return { service, prisma, tx, emitter };
}

describe('recomputeQueue — ETA pass (CR-2026-105b)', () => {
  it('ranks first, then writes estimates for ranked and in-service visits', async () => {
    const h = build();
    await h.service.recomputeQueue('site-1');

    // Ranking untouched: positions 1 and 2 in arrival order, no ETA fields on the ticket write.
    const ticketWrites = (h.tx.queueTicket.update.mock.calls as any[]).map((c) => c[0]);
    expect(ticketWrites.map((w) => w.data.queueRank)).toEqual([1, 2]);
    for (const w of ticketWrites) {
      expect(w.data).not.toHaveProperty('currentEtaStartAt');
      expect(w.data).not.toHaveProperty('currentEtaCompleteAt');
    }

    // Ranked visits carry the projection.
    const visitWrites = (h.tx.serviceVisit.update.mock.calls as any[]).map((c) => c[0]);
    const a = visitWrites.find((w) => w.where.id === 'visit-a')!;
    const b = visitWrites.find((w) => w.where.id === 'visit-b')!;
    expect(a.data.currentEtaStartAt).toBeInstanceOf(Date);
    expect(a.data.currentEtaCompleteAt.getTime() - a.data.currentEtaStartAt.getTime()).toBe(60 * 60_000);
    expect(b.data.currentEtaStartAt.getTime()).toBeGreaterThan(a.data.currentEtaStartAt.getTime());

    // The in-service visit is republished and its bay learns when it frees up.
    const busy = visitWrites.find((w) => w.where.id === 'visit-busy')!;
    expect(busy.data.currentEtaCompleteAt).toBeInstanceOf(Date);
    expect(h.tx.resourceOccupancy.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serviceVisitId: 'visit-busy', status: 'OCCUPIED' } }),
    );

    // Decision snapshots (first ranking = change) carry the estimate.
    const decisions = (h.tx.queueDecision.create.mock.calls as any[]).map((c) => c[0].data);
    expect(decisions.length).toBe(2);
    expect(decisions[0].etaStartAt).toBeInstanceOf(Date);

    // Lock released and the boards poked.
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(h.emitter.emit).toHaveBeenCalledWith('queue.recomputed', expect.objectContaining({ siteId: 'site-1' }));
  });

  it('an ETA failure never stops ranking (positions still persist, lock still released)', async () => {
    const h = build({ etaThrows: true });
    await h.service.recomputeQueue('site-1');
    const ticketWrites = (h.tx.queueTicket.update.mock.calls as any[]).map((c) => c[0]);
    expect(ticketWrites.map((w) => w.data.queueRank)).toEqual([1, 2]);
    const visitWrites = (h.tx.serviceVisit.update.mock.calls as any[]).map((c) => c[0]);
    for (const w of visitWrites) expect(w.data).not.toHaveProperty('currentEtaCompleteAt');
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(h.emitter.emit).toHaveBeenCalled();
  });
});
