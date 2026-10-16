import { describe, it, expect, vi } from 'vitest';
import { ResourcesService } from '../resources.service';

/**
 * CR-2026-119 §5 — a vehicle moves between positions during one visit.
 *
 * The case management described: mechanical work on a lift, then the car goes
 * to the wash bay. Before this CR the hand-placement guard allowed only WAITING
 * tickets, so a vehicle released from a lift — by then CALLED — could never be
 * placed again, and "transfer to the wash area" was impossible. Three promises
 * are tested here, and the live probe of 2026-10-16 is what found the gap.
 */

const LIFT = {
  id: 'lift-1', code: 'BAY-01', name: 'Heavy Lift 1', resourceCategory: 'BAY', liftType: 'heavy',
  isActive: true, schedulingEnabled: true, supportsSedan: true, supportsSuv: true,
  retiredAt: null, occupancy: null, operationalStatus: null,
};
const WASH = { ...LIFT, id: 'wash-1', code: 'PWASH-01', name: 'Vehicle Wash Bay', resourceCategory: 'POWER_WASH', liftType: null };

const ticket = (displayStatus: string) => ({
  id: 'tick-1', ticketNumber: 'B01-001', serviceVisitId: 'visit-1', queueRank: 1, displayStatus,
  serviceVisit: { vehicle: { serviceClass: 'SEDAN_CLASS' } },
});

function build(opts: {
  resource: Record<string, unknown>;
  ticket: Record<string, unknown>;
  /** Where the vehicle currently is, if anywhere else. */
  elsewhere?: { code: string; name: string } | null;
  /** The open service items on the visit, by whether each needs the wash. */
  items?: boolean[];
}) {
  const prisma: any = {
    workResource: { findUnique: vi.fn(async () => opts.resource) },
    queueTicket: { findUnique: vi.fn(async () => opts.ticket), update: vi.fn(async () => ({})) },
    resourceOccupancy: {
      upsert: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => (opts.elsewhere ? { resource: opts.elsewhere } : null)),
    },
    serviceOrderItem: {
      findMany: vi.fn(async () => (opts.items ?? []).map((requiresPowerWash) => ({ serviceType: { requiresPowerWash } }))),
    },
    queueEvent: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const audit = { log: vi.fn(async () => undefined) };
  return new ResourcesService(prisma as never, audit as never);
}

const attempt = (svc: ResourcesService, resourceId: string) => svc.assignToResource(resourceId, 'tick-1', null, 'user-1');

describe('a vehicle can be placed again after it has been released', () => {
  it('a CALLED ticket is no longer refused on status', async () => {
    const svc = build({ resource: LIFT, ticket: ticket('CALLED') });
    await expect(attempt(svc, 'lift-1')).resolves.toBeDefined();
  });

  it('an IN_SERVICE ticket can move too — the car is mid-visit, not finished', async () => {
    const svc = build({ resource: WASH, ticket: ticket('IN_SERVICE'), items: [true] });
    await expect(attempt(svc, 'wash-1')).resolves.toBeDefined();
  });

  it('a finished or cancelled ticket is still refused', async () => {
    for (const status of ['COMPLETED', 'CANCELLED']) {
      const svc = build({ resource: LIFT, ticket: ticket(status) });
      await expect(attempt(svc, 'lift-1')).rejects.toThrow(/cannot assign/);
    }
  });
});

describe('one vehicle, one place', () => {
  it('refuses to place a vehicle that is still at another position, and names it', async () => {
    const svc = build({ resource: WASH, ticket: ticket('CALLED'), elsewhere: { code: 'BAY-01', name: 'Heavy Lift 1' }, items: [true] });
    await expect(attempt(svc, 'wash-1')).rejects.toThrow(/still at Heavy Lift 1 \(BAY-01\)/);
  });

  it('is satisfied once the other position has been released', async () => {
    const svc = build({ resource: WASH, ticket: ticket('CALLED'), elsewhere: null, items: [true] });
    await expect(attempt(svc, 'wash-1')).resolves.toBeDefined();
  });
});

describe('the wash bay takes washing and nothing else', () => {
  it('refuses a visit with only mechanical work', async () => {
    const svc = build({ resource: WASH, ticket: ticket('CALLED'), items: [false, false] });
    await expect(attempt(svc, 'wash-1')).rejects.toThrow(/vehicle wash bay/);
  });

  it('accepts a visit with cleaning on it, even alongside mechanical work', async () => {
    // A lift first, the wash after: the rule is one-directional on purpose.
    const svc = build({ resource: WASH, ticket: ticket('CALLED'), items: [false, true] });
    await expect(attempt(svc, 'wash-1')).resolves.toBeDefined();
  });

  it('does not judge a visit that has no open items yet', async () => {
    const svc = build({ resource: WASH, ticket: ticket('WAITING'), items: [] });
    await expect(attempt(svc, 'wash-1')).resolves.toBeDefined();
  });

  it('never applies the wash rule to a service position', async () => {
    // Mechanical-only work on a lift is the normal case and must stay untouched.
    const svc = build({ resource: LIFT, ticket: ticket('WAITING'), items: [false] });
    await expect(attempt(svc, 'lift-1')).resolves.toBeDefined();
  });
});
