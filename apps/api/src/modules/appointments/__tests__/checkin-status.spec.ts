import { describe, it, expect, vi } from 'vitest';
import { CheckInService } from '../check-in.service';

/**
 * CR-2026-070 — which appointment statuses can be checked in. RESCHEDULED is still an
 * active, upcoming appointment and must be checkable-in; terminal statuses cannot.
 */
function buildCheckIn(status: string) {
  const appt = {
    id: 'appt1',
    status,
    serviceVisit: null,
    customerId: 'c1',
    vehicleId: 'v1',
    siteId: 's1',
    services: [{ serviceType: { requiresMileage: false } }],
    customer: { notificationOptInSms: false, notificationOptInEmail: false },
    vehicle: { serviceClass: null, weightClass: null },
    site: { code: 'BERT-01', timezone: 'America/Jamaica' },
  };
  const prisma: any = {
    appointment: { findUnique: vi.fn(async () => appt) },
    serviceVisit: { findFirst: vi.fn(async () => null) },
    customer: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => ({ serviceVisit: { id: 'sv1' }, queueTicket: { ticketNumber: 'A001' }, statusToken: 'tok' })),
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new CheckInService(prisma as any, statusHistory as any, audit as any);
  return { service, prisma };
}

describe('CheckInService — checkable-in statuses (CR-2026-070)', () => {
  it.each(['CONFIRMED', 'DRAFT', 'RESCHEDULED'])('allows check-in for %s', async (status) => {
    const h = buildCheckIn(status);
    await h.service.checkIn('appt1', 'u1');
    expect(h.prisma.$transaction).toHaveBeenCalled();
  });

  it.each(['CANCELLED', 'COMPLETED', 'CHECKED_IN', 'MISSED'])('rejects check-in for %s', async (status) => {
    const h = buildCheckIn(status);
    await expect(h.service.checkIn('appt1', 'u1')).rejects.toThrow(/cannot check in/i);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
