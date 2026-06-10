import { describe, it, expect, vi } from 'vitest';
import { CheckInService } from '../check-in.service';

/**
 * P4(b) — notification consent capture at check-in. Only an explicit, changed
 * opt-in value is persisted to the Customer and audited; absence leaves the
 * customer untouched (default opt-out preserved). No notifications are sent.
 */
function buildCheckIn(currentOptIn: { sms: boolean; email: boolean }) {
  const appt = {
    id: 'appt1',
    status: 'CONFIRMED',
    serviceVisit: null,
    customerId: 'c1',
    vehicleId: 'v1',
    siteId: 's1',
    services: [{ serviceType: { requiresMileage: false } }],
    customer: { notificationOptInSms: currentOptIn.sms, notificationOptInEmail: currentOptIn.email },
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
  return { service, prisma, audit };
}

describe('P4(b) check-in notification opt-in capture', () => {
  it('persists and audits a changed opt-in (opt-out → opt-in)', async () => {
    const h = buildCheckIn({ sms: false, email: false });

    await h.service.checkIn('appt1', 'u1', undefined, undefined, {
      notificationOptInSms: true,
      notificationOptInEmail: true,
    });

    expect(h.prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1' },
        data: { notificationOptInSms: true, notificationOptInEmail: true },
      }),
    );
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMER_NOTIFICATION_OPTIN',
        entityType: 'Customer',
        entityId: 'c1',
        beforeJson: { notificationOptInSms: false, notificationOptInEmail: false },
        afterJson: { notificationOptInSms: true, notificationOptInEmail: true },
      }),
    );
  });

  it('does nothing when opt-in is not provided (default opt-out preserved)', async () => {
    const h = buildCheckIn({ sms: false, email: false });
    await h.service.checkIn('appt1', 'u1', undefined, undefined, {});
    expect(h.prisma.customer.update).not.toHaveBeenCalled();
    const optInAudits = h.audit.log.mock.calls.filter((c: any[]) => c[0]?.action === 'CUSTOMER_NOTIFICATION_OPTIN');
    expect(optInAudits.length).toBe(0);
  });

  it('does not write when the provided value equals the current value', async () => {
    const h = buildCheckIn({ sms: true, email: true });
    await h.service.checkIn('appt1', 'u1', undefined, undefined, {
      notificationOptInSms: true,
      notificationOptInEmail: true,
    });
    expect(h.prisma.customer.update).not.toHaveBeenCalled();
  });

  it('persists only the changed channel', async () => {
    const h = buildCheckIn({ sms: false, email: true });
    await h.service.checkIn('appt1', 'u1', undefined, undefined, {
      notificationOptInSms: true,
      notificationOptInEmail: true,
    });
    expect(h.prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notificationOptInSms: true } }),
    );
  });
});
