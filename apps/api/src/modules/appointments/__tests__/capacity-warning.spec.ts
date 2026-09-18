import { describe, it, expect, vi } from 'vitest';
import { AppointmentsService } from '../appointments.service';
import { ETA_DEFAULTS } from '../../scheduling/eta/eta.config';

/**
 * CR-2026-105c (Assumption 11) — staff bookings consume the same constrained
 * capacity: 409 CAPACITY_FULL unless acknowledged, and the acknowledgement is
 * audited. Without an EtaService (legacy specs) the check is skipped.
 */
const MIN = 60_000;
const start = new Date(Date.now() + 24 * 60 * MIN);

function build(opts: { capacity?: number; existing?: number; withEta?: boolean } = {}) {
  const existing = Array.from({ length: opts.existing ?? 0 }, () => ({ scheduledStartAt: start, scheduledEndAt: new Date(start.getTime() + 60 * MIN) }));
  const tx: any = {
    appointment: { create: vi.fn(async ({ data }: any) => ({ id: 'appt-1', ...data, services: [], customer: {}, vehicle: {}, site: {} })) },
  };
  const prisma: any = {
    businessRuleConfig: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    serviceType: { findMany: vi.fn(async () => [{ id: 'st-1', code: 'OIL-01', baseDurationMinutes: 60, sedanDurationMinutes: null, suvDurationMinutes: null }]) },
    appointment: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => existing) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const eta = opts.withEta === false ? undefined : ({ loadRules: vi.fn(async () => ({ ...ETA_DEFAULTS, capacity: opts.capacity ?? 1 })) } as any);
  const service = new AppointmentsService(prisma, statusHistory as any, audit as any, eta);
  return { service, prisma, tx, audit };
}

const dto = (acknowledge?: boolean) => ({
  siteId: 'site-1',
  customerId: 'c1',
  vehicleId: 'v1',
  scheduledStartAt: start.toISOString(),
  serviceTypes: [{ serviceTypeCode: 'OIL-01' }],
  ...(acknowledge ? { acknowledgeCapacity: true } : {}),
});

describe('AppointmentsService.create — workshop capacity (warn-not-block)', () => {
  it('refuses with 409 CAPACITY_FULL when every position is booked', async () => {
    const h = build({ capacity: 1, existing: 1 });
    await expect(h.service.create(dto() as any, 'user-1')).rejects.toMatchObject({ response: { code: 'CAPACITY_FULL', capacity: 1, booked: 1 } });
    expect(h.tx.appointment.create).not.toHaveBeenCalled();
  });

  it('books when acknowledged and audits the override', async () => {
    const h = build({ capacity: 1, existing: 1 });
    await h.service.create(dto(true) as any, 'user-1');
    expect(h.tx.appointment.create).toHaveBeenCalled();
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'APPOINTMENT_CAPACITY_ACKNOWLEDGED', actorUserId: 'user-1', reasonCode: 'CAPACITY_FULL' }));
  });

  it('books normally when a position is free, with no audit row', async () => {
    const h = build({ capacity: 2, existing: 1 });
    await h.service.create(dto() as any, 'user-1');
    expect(h.tx.appointment.create).toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('skips the check entirely without an EtaService (legacy construction)', async () => {
    const h = build({ withEta: false, existing: 5 });
    await h.service.create(dto() as any, 'user-1');
    expect(h.tx.appointment.create).toHaveBeenCalled();
  });
});
