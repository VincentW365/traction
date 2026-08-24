import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ResourcesService } from '../resources.service';

/**
 * CR-2026-095 — configuration is live operational truth, so the ASSIGNMENT path is
 * where it must hold. A maintenance bay that still accepts vehicles makes the
 * status screen decorative; these tests make the refusals load-bearing.
 *
 * The mobile-jack safety rule is pinned here too: it is a domain rule with its own
 * audited override, and no capability checkbox may reach around it.
 */

const TICKET = {
  id: 'tick-1',
  ticketNumber: 'B01-001',
  serviceVisitId: 'visit-1',
  queueRank: 1,
  displayStatus: 'WAITING',
  serviceVisit: { vehicle: { serviceClass: 'SEDAN_CLASS' } },
};

const RESOURCE = {
  id: 'res-1',
  code: 'BAY-1',
  name: 'Bay 1',
  liftType: null,
  isActive: true,
  schedulingEnabled: true,
  supportsSedan: true,
  supportsSuv: true,
  retiredAt: null,
  occupancy: null,
  operationalStatus: null,
};

function build(resource: Record<string, any>, ticket: Record<string, any> = TICKET) {
  const prisma: any = {
    workResource: { findUnique: vi.fn(async () => resource) },
    queueTicket: { findUnique: vi.fn(async () => ticket), update: vi.fn(async () => ({})) },
    resourceOccupancy: { upsert: vi.fn(async () => ({})) },
    queueEvent: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  const audit = { log: vi.fn(async () => ({})) };
  return { service: new ResourcesService(prisma as any, audit as any), prisma, audit };
}

describe('assignment respects persisted configuration', () => {
  it('assigns to a healthy, compatible resource', async () => {
    const h = build({ ...RESOURCE });
    const r = await h.service.assignToResource('res-1', 'tick-1', null, 'user-1');
    expect(r.resourceCode).toBe('BAY-1');
  });

  it('refuses a retired resource', async () => {
    const h = build({ ...RESOURCE, retiredAt: new Date() });
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).rejects.toThrow(/retired/i);
  });

  it('refuses a deactivated resource', async () => {
    const h = build({ ...RESOURCE, isActive: false });
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).rejects.toThrow(/deactivated/i);
  });

  it('refuses a resource held out of scheduling', async () => {
    const h = build({ ...RESOURCE, schedulingEnabled: false });
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).rejects.toThrow(/not accepting/i);
  });

  it('refuses maintenance and names the reason and expected return', async () => {
    const h = build({
      ...RESOURCE,
      operationalStatus: {
        status: 'MAINTENANCE',
        reason: 'Lift repair',
        expectedReturnAt: new Date('2026-08-23T09:00:00Z'),
      },
    });
    const err = await h.service.assignToResource('res-1', 'tick-1', null, 'u').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/maintenance/i);
    expect(err.message).toMatch(/Lift repair/);
    expect(err.message).toMatch(/2026-08-23/);
  });

  it('becomes assignable again the moment the status returns to AVAILABLE', async () => {
    const h = build({
      ...RESOURCE,
      operationalStatus: { status: 'AVAILABLE', reason: null, expectedReturnAt: null },
    });
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).resolves.toBeTruthy();
  });
});

describe('vehicle-class compatibility', () => {
  const suvTicket = {
    ...TICKET,
    serviceVisit: { vehicle: { serviceClass: 'SUV_CLASS' } },
  };

  it('refuses an SUV on a sedan-only resource', async () => {
    const h = build({ ...RESOURCE, supportsSuv: false }, suvTicket);
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).rejects.toThrow(/sedans only/i);
  });

  it('refuses a sedan on an SUV-only resource', async () => {
    const h = build({ ...RESOURCE, supportsSedan: false });
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).rejects.toThrow(/SUVs only/i);
  });

  it('allows an SUV on a both-classes bay', async () => {
    const h = build({ ...RESOURCE }, suvTicket);
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).resolves.toBeTruthy();
  });
});

describe('the mobile-jack safety rule survives configurability', () => {
  const jack = { ...RESOURCE, code: 'JACK-1', name: 'Mobile Jack 1', liftType: 'mobile' };
  const suvTicket = {
    ...TICKET,
    serviceVisit: { vehicle: { serviceClass: 'SUV_CLASS' } },
  };

  it('still blocks an SUV even when the capability checkbox says supportsSuv', async () => {
    // The checkbox is operational configuration; the DMAIC rule is a safety rule.
    // An administrator ticking a box must not be able to bypass it.
    const h = build({ ...jack, supportsSuv: true }, suvTicket);
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).rejects.toThrow(/sedan-only.*DMAIC/i);
  });

  it('allows the SUV only through the audited manager override', async () => {
    const h = build({ ...jack, supportsSuv: true }, suvTicket);
    await expect(
      h.service.assignToResource('res-1', 'tick-1', null, 'mgr-1', {
        mobileJackOverride: true,
        overrideReason: 'Front axle only, supervisor present',
      }),
    ).resolves.toBeTruthy();
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MOBILE_JACK_OVERRIDE' }),
    );
  });

  it('sedans use the jack without ceremony', async () => {
    const h = build({ ...jack });
    await expect(h.service.assignToResource('res-1', 'tick-1', null, 'u')).resolves.toBeTruthy();
  });
});
