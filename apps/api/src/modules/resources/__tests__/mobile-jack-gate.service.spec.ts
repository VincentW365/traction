import { describe, it, expect, vi } from 'vitest';
import { ResourcesService } from '../resources.service';

/**
 * DMAIC Rule 3 — server-side mobile-jack gate at the assignment boundary.
 * Mobile jacks may only be assigned to SEDAN_CLASS vehicles; otherwise blocked
 * unless a manager override is supplied (which is audited).
 */
function build(liftType: string, serviceClass: string | null) {
  const prisma: any = {
    workResource: {
      findUnique: vi.fn(async () => ({ id: 'r1', code: 'MJACK-01', name: 'Mobile Jack 1', liftType, occupancy: null })),
    },
    queueTicket: {
      findUnique: vi.fn(async () => ({
        id: 't1',
        displayStatus: 'WAITING',
        queueRank: 1,
        serviceVisitId: 'sv1',
        serviceVisit: { vehicle: { serviceClass } },
      })),
      update: vi.fn(async () => ({})),
    },
    resourceOccupancy: { upsert: vi.fn(async () => ({})) },
    queueEvent: { create: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  const audit = { log: vi.fn(async () => ({})) };
  const service = new ResourcesService(prisma as any, audit as any);
  return { service, prisma, audit };
}

describe('ResourcesService.assignToResource — mobile-jack gate (DMAIC Rule 3)', () => {
  it('eligible sedan: assigns to mobile jack, no override audit', async () => {
    const h = build('mobile', 'SEDAN_CLASS');
    await expect(h.service.assignToResource('r1', 't1', null, 'u1')).resolves.toBeDefined();
    expect(h.prisma.resourceOccupancy.upsert).toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('ineligible non-sedan: blocks mobile-jack assignment without override', async () => {
    const h = build('mobile', 'SUV_HEAVY');
    await expect(h.service.assignToResource('r1', 't1', null, 'u1')).rejects.toThrow(/sedan-only/i);
    expect(h.prisma.resourceOccupancy.upsert).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('unknown class: blocks mobile-jack assignment without override (fail-safe)', async () => {
    const h = build('mobile', null);
    await expect(h.service.assignToResource('r1', 't1', null, 'u1')).rejects.toThrow(/sedan-only/i);
    expect(h.prisma.resourceOccupancy.upsert).not.toHaveBeenCalled();
  });

  it('manager override: assigns non-sedan to mobile jack AND writes an audit record', async () => {
    const h = build('mobile', 'SUV_HEAVY');
    await expect(
      h.service.assignToResource('r1', 't1', null, 'u1', { mobileJackOverride: true, overrideReason: 'manager ok' }),
    ).resolves.toBeDefined();
    expect(h.prisma.resourceOccupancy.upsert).toHaveBeenCalled();
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MOBILE_JACK_OVERRIDE', actorUserId: 'u1', notes: 'manager ok' }),
    );
  });

  it('non-mobile resource: service class is irrelevant (SUV on a stand is fine)', async () => {
    const h = build('heavy', 'SUV_HEAVY');
    await expect(h.service.assignToResource('r1', 't1', null, 'u1')).resolves.toBeDefined();
    expect(h.audit.log).not.toHaveBeenCalled();
  });
});
