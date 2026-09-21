import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationsService } from '../notifications.service';

/**
 * CR-2026-056 — 24h appointment reminder sweep. `now` is injected for determinism.
 * CR-2026-112 — the reminder is an email; a customer with no address is skipped.
 */
function appt(customerOverrides: Partial<any> = {}) {
  return {
    id: 'appt-1',
    status: 'CONFIRMED',
    scheduledStartAt: new Date('2026-06-30T14:00:00Z'),
    appointmentNumber: 'BK-0001',
    customerId: 'cust-1',
    vehicleId: 'veh-1',
    customer: {
      firstName: 'Jo',
      phone: '+18760000000',
      email: 'jo@example.com',
      notificationOptInEmail: true,
      ...customerOverrides,
    },
    services: [{ serviceType: { name: 'Oil Change' } }],
    site: { name: "Bert's", timezone: 'America/Jamaica' },
  };
}

function build(opts: {
  appointments: any[];
  alreadySent?: number;
  enabled?: boolean | null;
  hours?: number | null;
}) {
  const prisma: any = {
    businessRuleConfig: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.ruleKey === 'appointment_reminder_enabled') {
          return opts.enabled == null ? null : { valueJson: opts.enabled };
        }
        if (where.ruleKey === 'appointment_reminder_hours') {
          return opts.hours == null ? null : { valueJson: opts.hours };
        }
        return null;
      }),
    },
    appointment: { findMany: vi.fn(async () => opts.appointments) },
    notificationLog: { count: vi.fn(async () => opts.alreadySent ?? 0) },
  };
  const provider: any = { send: vi.fn() };
  const service = new NotificationsService(prisma, provider, { emailConfigured: false, mode: 'LIVE' });
  const queueSpy = vi.spyOn(service, 'queue').mockResolvedValue('log-1');
  return { service, prisma, queueSpy };
}

// 2026-06-29T15:00Z → appt at 2026-06-30T14:00Z is ~23h out, inside the 24h window.
const NOW = new Date('2026-06-29T15:00:00Z');

describe('sweepAppointmentReminders (CR-2026-056)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends ONE email reminder for an upcoming appointment in the window', async () => {
    const h = build({ appointments: [appt()] });
    const res = await h.service.sweepAppointmentReminders(NOW);

    expect(res.sent).toBe(1);
    expect(h.queueSpy).toHaveBeenCalledTimes(1);
    expect(h.queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Appointment',
        entityId: 'appt-1',
        channel: 'EMAIL',
        reason: 'APPOINTMENT_REMINDER',
        recipient: 'jo@example.com',
      }),
    );
    // No scheduledAt — the sweep IS the schedule, so it sends immediately.
    expect(h.queueSpy.mock.calls[0][0]).not.toHaveProperty('scheduledAt');
  });

  it('skips a customer with no email address on file', async () => {
    const h = build({ appointments: [appt({ email: null })] });
    const res = await h.service.sweepAppointmentReminders(NOW);

    expect(res).toEqual({ sent: 0, skipped: 1 });
    expect(h.queueSpy).not.toHaveBeenCalled();
  });

  it('is idempotent — skips an appointment already reminded', async () => {
    const h = build({ appointments: [appt()], alreadySent: 1 });
    const res = await h.service.sweepAppointmentReminders(NOW);

    expect(res).toEqual({ sent: 0, skipped: 1 });
    expect(h.queueSpy).not.toHaveBeenCalled();
  });

  /**
   * CR-2026-113 — a reminder is about an appointment this customer chose to
   * make. Gating it on the optional-email preference meant a customer who had
   * not opted in to CAMPAIGNS silently lost the reminder for their own booking.
   */
  it('still reminds a customer who has not opted in to optional email', async () => {
    const h = build({
      appointments: [appt({ notificationOptInEmail: false })],
    });
    const res = await h.service.sweepAppointmentReminders(NOW);

    expect(res.sent).toBe(1);
    expect(h.queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'REMINDER', recipient: 'jo@example.com' }),
    );
  });

  it('does nothing when appointment_reminder_enabled is false', async () => {
    const h = build({ appointments: [appt()], enabled: false });
    const res = await h.service.sweepAppointmentReminders(NOW);

    expect(res).toEqual({ sent: 0, skipped: 0 });
    expect(h.prisma.appointment.findMany).not.toHaveBeenCalled();
    expect(h.queueSpy).not.toHaveBeenCalled();
  });
});
