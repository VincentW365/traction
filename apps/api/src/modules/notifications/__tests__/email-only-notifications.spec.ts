import { describe, it, expect, vi } from 'vitest';
import { NotificationsService } from '../notifications.service';
import { NotificationTemplateStore } from '../templates/template-store.service';
import { DEFAULT_TEMPLATES, defaultTemplateFor } from '../templates/default-templates';

/**
 * CR-2026-112 — Customer Email Notifications (docs/131).
 *
 * What these checks are really protecting:
 *  - the appointment emails are now MANAGER-EDITABLE, and a manager's wording
 *    must be what the customer receives;
 *  - a deployment whose template table has not been seeded must still send a
 *    correct booking confirmation (the code fallback), never a blank one;
 *  - a notification a manager switched OFF stays off — it does not quietly
 *    reappear as factory wording;
 *  - no automatic flow can put a non-email message on the wire.
 */

const TEMPLATE_ROW = {
  id: 'tpl-appt',
  key: 'APPOINTMENT_CONFIRMATION_EMAIL',
  reason: 'APPOINTMENT_CONFIRMATION',
  channel: 'EMAIL',
  name: 'Appointment confirmation',
  subject: 'Appointment confirmed — {{appointmentReference}}',
  body: 'Hi {{customerFirstName}},\n\nYour appointment at {{siteName}} is confirmed.\n\nReference: {{appointmentReference}}\nWhen: {{appointmentWhen}}\nVehicle: {{vehicleDescription}}\n\nView, move or cancel: {{manageUrl}}\n\n{{siteName}}',
  enabled: true,
  version: 7,
};

function build(opts?: { template?: Record<string, unknown> | null }) {
  const prisma = {
    notificationTemplate: {
      findFirst: vi.fn(async () => (opts?.template === undefined ? TEMPLATE_ROW : opts.template)),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tpl-new', version: 1, enabled: true, ...data })),
    },
    notificationLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'log-1', ...data })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
  };
  type SentInput = { channel: string; recipient: string; subject?: string; body?: string };
  const provider = {
    send: vi.fn(async (_input: SentInput) => ({ success: true, providerReference: 'msg-1' })),
  };
  const store = new NotificationTemplateStore(prisma as never);
  const service = new NotificationsService(
    prisma as never,
    provider as never,
    { emailConfigured: true, mode: 'LIVE' },
    undefined,
    store,
  );
  return { service, prisma, provider, store };
}

const APPOINTMENT = {
  appointmentId: 'appt-1',
  email: 'jane@example.com',
  customerFirstName: 'Jane',
  scheduledStartAt: new Date('2026-09-25T13:00:00Z'),
  durationMinutes: 80,
  services: ['Oil Change'],
  siteName: "Bert's Service Centre",
  timezone: 'America/Jamaica',
  reference: 'BK-4821',
  manageUrl: 'https://book.example/book/manage/tok',
  vehicle: 'Toyota Corolla · plate ending 34',
  customerId: 'cust-1',
  vehicleId: 'veh-1',
};

describe('appointment emails come from the manager-editable template', () => {
  it("sends the manager's wording, and records which template and version produced it", async () => {
    const { service, prisma, provider } = build();
    await service.queueAppointmentMessage('CONFIRMED', APPOINTMENT);

    const sent = provider.send.mock.calls[0][0];
    expect(sent.channel).toBe('EMAIL');
    expect(sent.recipient).toBe('jane@example.com');
    expect(sent.subject).toBe('Appointment confirmed — BK-4821');
    expect(sent.body).toBeDefined();
    expect(sent.body!).toContain('Hi Jane,');
    expect(sent.body!).toContain('Reference: BK-4821');
    expect(sent.body!).toContain('Vehicle: Toyota Corolla · plate ending 34');
    expect(sent.body!).toContain('View, move or cancel: https://book.example/book/manage/tok');

    const logged = (prisma.notificationLog.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(logged.templateKey).toBe('APPOINTMENT_CONFIRMATION_EMAIL');
    expect(logged.templateVersion).toBe(7);
    expect(logged.reason).toBe('APPOINTMENT_CONFIRMATION');
    // CR-2026-106 — history linkage survives the move to templates.
    expect(logged.customerId).toBe('cust-1');
    expect(logged.vehicleId).toBe('veh-1');
  });

  it('falls back to the code wording when the template table has not been seeded', async () => {
    // findFirst returns null AND the self-heal create fails (e.g. read-only/racing):
    // the booking confirmation must still go out with correct content.
    const { service, prisma, provider } = build({ template: null });
    prisma.notificationTemplate.create.mockRejectedValue(new Error('no table'));

    await service.queueAppointmentMessage('CONFIRMED', APPOINTMENT);

    const sent = provider.send.mock.calls[0][0];
    expect(sent.subject!).toContain('Appointment confirmed');
    expect(sent.body!).toContain('BK-4821');
    expect(sent.body!.trim().length).toBeGreaterThan(0);
  });

  it('a cancellation email does not offer a manage link or arrival instructions', async () => {
    const { service, store } = build({ template: null });
    const rendered = await store.render('APPOINTMENT_CANCELLED', {
      customerFirstName: 'Jane',
      siteName: "Bert's",
      appointmentReference: 'BK-4821',
      appointmentWhen: 'Fri, Sep 25, 9:00 AM',
      vehicleDescription: 'Toyota Corolla',
    });
    expect(rendered!.body).not.toMatch(/manage|View, move or cancel/i);
    expect(rendered!.body).toContain('has been cancelled');
    void service;
  });

  it('sends nothing at all when the customer has no email address', async () => {
    const { service, provider, prisma } = build();
    await service.queueAppointmentMessage('CONFIRMED', { ...APPOINTMENT, email: null });
    expect(provider.send).not.toHaveBeenCalled();
    expect(prisma.notificationLog.create).not.toHaveBeenCalled();
  });
});

describe('NotificationTemplateStore', () => {
  it('self-heals a missing template from factory wording and persists it once', async () => {
    const { store, prisma } = build({ template: null });
    const row = await store.resolve('PICKUP_READY' as never);
    expect(row!.key).toBe('PICKUP_READY_EMAIL');
    expect(prisma.notificationTemplate.create).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for a DISABLED template — a manager switching it off means off', async () => {
    const { store } = build({ template: { ...TEMPLATE_ROW, enabled: false } });
    expect(await store.render('APPOINTMENT_CONFIRMATION' as never, { customerFirstName: 'Jane' })).toBeNull();
  });

  it('returns nothing when the rendered body is empty, so no blank email can be sent', async () => {
    const { store } = build({ template: { ...TEMPLATE_ROW, body: '{{staffEditableUpdate}}' } });
    expect(await store.render('APPOINTMENT_CONFIRMATION' as never, {})).toBeNull();
  });
});

describe('the seeded template set matches the directive', () => {
  it('has one email template for every reason the directive names', () => {
    for (const reason of [
      'SERVICE_DUE',
      'CUSTOMER_ACTION_REQUIRED',
      'PICKUP_READY',
      'APPOINTMENT_CONFIRMATION',
      'APPOINTMENT_CHANGED',
      'APPOINTMENT_CANCELLED',
      'APPOINTMENT_REMINDER',
    ]) {
      const t = defaultTemplateFor(reason);
      expect(t, reason).toBeDefined();
      expect(t!.channel).toBe('EMAIL');
    }
  });

  it('leaves the substance of a customer-action email to the advisor', () => {
    const t = defaultTemplateFor('CUSTOMER_ACTION_REQUIRED')!;
    expect(t.body).toContain('{{actionRequired}}');
    // No invented reason, no internal state disclosed by default.
    expect(t.body).not.toMatch(/technician|bay|KPI|target/i);
  });

  it('seeds no SMS wording at all', () => {
    expect(DEFAULT_TEMPLATES.every((t) => t.channel === 'EMAIL')).toBe(true);
    expect(DEFAULT_TEMPLATES.some((t) => t.key.endsWith('_SMS'))).toBe(false);
  });
});
