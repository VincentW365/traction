import { describe, it, expect, vi } from 'vitest';
import { StatusController } from '../status.controller';

function build(visit: unknown, rankedCount = 0) {
  const prisma: any = {
    serviceVisit: { findFirst: vi.fn(async () => visit) },
    queueTicket: { count: vi.fn(async () => rankedCount) },
  };
  return { ctrl: new StatusController(prisma), prisma };
}

const baseVisit = (over: Record<string, unknown> = {}) => ({
  siteId: 'site-1',
  status: 'CHECKED_IN',
  partsReadiness: 'NOT_REQUIRED',
  vehicle: { plateNumber: 'SC1211KC' },
  queueTicket: { ticketNumber: 'A007', queueRank: 4, displayStatus: 'WAITING' },
  appointment: { services: [{ serviceType: { name: 'Oil Change' } }] },
  serviceOrders: [],
  ...over,
});

describe('StatusController.getStatus — position context (CR-2026-028)', () => {
  it('returns ahead/behind/total from rank + ranked count, with a time-free message', async () => {
    const { ctrl } = build(baseVisit(), 8); // #4 of 8
    const r: any = await ctrl.getStatus('tok');
    expect(r.position).toBe(4);
    expect(r.totalInQueue).toBe(8);
    expect(r.aheadCount).toBe(3);
    expect(r.behindCount).toBe(4);
    expect(r.estimatedWait).toMatch(/queue/i); // friendly, position #4 → "in the queue"
    expect(r.estimatedWait).not.toMatch(/\bmin\b|minute|hour/i); // no ETA
    expect(r.vehiclePlate).toBe('***11KC'); // masked to last 4
  });

  it("says 'next' at position 1 (0 ahead)", async () => {
    const { ctrl } = build(baseVisit({ queueTicket: { ticketNumber: 'A001', queueRank: 1, displayStatus: 'WAITING' } }), 5);
    const r: any = await ctrl.getStatus('tok');
    expect(r.aheadCount).toBe(0);
    expect(r.behindCount).toBe(4);
    expect(r.estimatedWait).toMatch(/next/i);
  });

  it('omits counts + skips the count query when not in the ranked queue (in service)', async () => {
    const { ctrl, prisma } = build(
      baseVisit({ queueTicket: { ticketNumber: 'A002', queueRank: null, displayStatus: 'IN_SERVICE' }, status: 'IN_SERVICE' }),
    );
    const r: any = await ctrl.getStatus('tok');
    expect(r.position).toBeNull();
    expect(r.aheadCount).toBeNull();
    expect(r.behindCount).toBeNull();
    expect(r.totalInQueue).toBe(0);
    expect(prisma.queueTicket.count).not.toHaveBeenCalled();
    expect(r.estimatedWait).toMatch(/in progress/i);
  });

  it('throws on a missing/expired token', async () => {
    const { ctrl } = build(null);
    await expect(ctrl.getStatus('bad')).rejects.toThrow(/expired or is invalid/i);
  });
});
