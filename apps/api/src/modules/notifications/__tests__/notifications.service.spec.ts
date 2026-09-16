import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationsService, deliveryDisplayState } from '../notifications.service';

/**
 * CR-2026-106 — the notification path tells the truth (docs/121 §C3).
 *
 *  - every EMAIL reaches the provider with a rendered subject + body, even when the
 *    caller passed only a legacy template key (the SMTP provider refuses empty bodies);
 *  - the status written to NotificationLog is the PROVIDER's verdict;
 *  - pickup-ready reports the real log status, never a hard-coded "SENT";
 *  - the display-state mapping never says "Sent" for a simulated/test-redirected row;
 *  - verifyEmail proves the transport and records the real send.
 */

function makePrisma() {
  const logs = new Map<string, Record<string, unknown>>();
  let n = 0;
  const prisma = {
    _logs: logs,
    notificationLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `log-${++n}`;
        const row = { id, ...data };
        logs.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...(logs.get(where.id) ?? { id: where.id }), ...data };
        logs.set(where.id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => logs.get(where.id) ?? null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    serviceVisit: { findUnique: vi.fn() },
    customer: { findUnique: vi.fn() },
    appointment: { findMany: vi.fn(async () => []) },
    businessRuleConfig: { findMany: vi.fn(async () => []) },
    site: { findUnique: vi.fn(async () => ({ name: "Bert's", timezone: 'America/Jamaica' })) },
  };
  return prisma;
}

const liveCaps = { smsConfigured: true, emailConfigured: true, mode: 'LIVE' as const };

describe('deliveryDisplayState', () => {
  it('never says Sent for a simulated or test-redirected row', () => {
    expect(deliveryDisplayState({ status: 'SENT', simulated: true })).toBe('SIMULATED');
    expect(deliveryDisplayState({ status: 'SENT', testRouted: true })).toBe('TEST_REDIRECTED');
    expect(deliveryDisplayState({ status: 'SENT' })).toBe('SENT');
  });
  it('maps the remaining lifecycle states one-to-one', () => {
    expect(deliveryDisplayState({ status: 'PENDING' })).toBe('QUEUED');
    expect(deliveryDisplayState({ status: 'SCHEDULED' })).toBe('QUEUED');
    expect(deliveryDisplayState({ status: 'FAILED' })).toBe('FAILED');
    expect(deliveryDisplayState({ status: 'DELIVERED' })).toBe('DELIVERED');
    expect(deliveryDisplayState({ status: 'MANUAL' })).toBe('MANUAL');
  });
});

describe('NotificationsService.queue → processNotification', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let provider: { send: ReturnType<typeof vi.fn>; verify?: ReturnType<typeof vi.fn> };
  let svc: NotificationsService;

  beforeEach(() => {
    prisma = makePrisma();
    provider = { send: vi.fn(async () => ({ success: true, providerReference: 'msg-1', accepted: ['x@y.z'], rejected: [] })) };
    svc = new NotificationsService(prisma as never, provider as never, liveCaps);
  });

  it('renders a subject + body for a legacy template key so the SMTP provider never sees an empty email', async () => {
    await svc.queue({
      entityType: 'ServiceVisit',
      entityId: 'sv-1',
      channel: 'EMAIL',
      templateKey: 'pickup_ready',
      templateData: { vehicleDescription: '2020 Honda Grace', siteName: "Bert's" },
      recipient: 'customer@example.com',
    });
    expect(provider.send).toHaveBeenCalledTimes(1);
    const sent = provider.send.mock.calls[0][0] as { subject?: string; body?: string; channel: string };
    expect(sent.channel).toBe('EMAIL');
    expect(sent.subject).toContain('2020 Honda Grace');
    expect((sent.body ?? '').length).toBeGreaterThan(20);
    // …and what was sent is persisted on the log for history.
    const row = [...prisma._logs.values()][0] as { status: string; subject?: string; body?: string };
    expect(row.status).toBe('SENT');
    expect(row.subject).toContain('2020 Honda Grace');
    expect(row.body).toContain('ready for pickup');
  });

  it('keeps a pre-rendered body untouched', async () => {
    await svc.queue({
      entityType: 'Appointment',
      entityId: 'a-1',
      channel: 'EMAIL',
      templateKey: 'appointment_confirmation',
      templateData: {},
      recipient: 'customer@example.com',
      subject: 'Custom subject',
      body: 'Custom body text',
    });
    const sent = provider.send.mock.calls[0][0] as { subject?: string; body?: string };
    expect(sent.subject).toBe('Custom subject');
    expect(sent.body).toBe('Custom body text');
  });

  it("writes FAILED with the provider's reason when the mail server refuses", async () => {
    provider.send.mockResolvedValueOnce({ success: false, failureReason: 'Recipient rejected by the mail server: 550 no such user' });
    await svc.queue({
      entityType: 'ServiceVisit',
      entityId: 'sv-1',
      channel: 'EMAIL',
      templateKey: 'pickup_ready',
      templateData: {},
      recipient: 'nobody@example.com',
    });
    const row = [...prisma._logs.values()][0] as { status: string; failureReason?: string };
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/550 no such user/);
  });

  it('writes FAILED when the provider throws (transport timeout)', async () => {
    provider.send.mockRejectedValueOnce(new Error('Connection timeout'));
    await svc.queue({
      entityType: 'ServiceVisit',
      entityId: 'sv-1',
      channel: 'EMAIL',
      templateKey: 'pickup_ready',
      templateData: {},
      recipient: 'customer@example.com',
    });
    const row = [...prisma._logs.values()][0] as { status: string; failureReason?: string };
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/Connection timeout/);
  });
});

describe('NotificationsService.sendPickupReady — honest outcome', () => {
  it('reports the REAL log status per channel (a failed email is FAILED, with its reason)', async () => {
    const prisma = makePrisma();
    prisma.serviceVisit.findUnique.mockResolvedValue({
      id: 'sv-1',
      siteId: 'site-1',
      customer: { id: 'c-1', firstName: 'Vincent', lastName: 'Wilson', phone: '8765551234', email: 'v@example.com' },
      vehicle: { plateNumber: '1234AB', make: 'Honda', model: 'Grace' },
      site: { name: "Bert's" },
      queueTickets: [{ ticketNumber: 'B-1' }],
      serviceOrders: [],
    });
    const provider = {
      send: vi.fn(async (input: { channel: string }) =>
        input.channel === 'EMAIL'
          ? { success: false, failureReason: 'Empty email body' }
          : { success: true, providerReference: 'sms-1' },
      ),
    };
    const svc = new NotificationsService(prisma as never, provider as never, liveCaps);
    const out = await svc.sendPickupReady('sv-1', ['SMS', 'EMAIL'], 'user-1');
    const sms = out.sent.find((s) => s.channel === 'SMS')!;
    const email = out.sent.find((s) => s.channel === 'EMAIL')!;
    expect(sms.status).toBe('SENT');
    expect(sms.displayState).toBe('SENT');
    expect(email.status).toBe('FAILED');
    expect(email.displayState).toBe('FAILED');
    expect(email.failureReason).toMatch(/Empty email body/);
  });
});

describe('NotificationsService.verifyEmail', () => {
  it('refuses to claim success when EMAIL_PROVIDER is stub', async () => {
    const prisma = makePrisma();
    const svc = new NotificationsService(prisma as never, { send: vi.fn() } as never, { smsConfigured: false, emailConfigured: false, mode: 'TEST' });
    const r = await svc.verifyEmail('me@example.com', 'u-1');
    expect(r.verified).toBe(false);
    expect(r.configured).toBe(false);
    expect(prisma.notificationLog.create).not.toHaveBeenCalled();
  });

  it('verifies the transport, sends a real message to the typed address and records the provider response', async () => {
    const prisma = makePrisma();
    const provider = {
      verify: vi.fn(async () => ({ ok: true, detail: 'connected and authenticated' })),
      send: vi.fn(async () => ({ success: true, providerReference: 'id-9', accepted: ['me@example.com'], rejected: [], response: '250 OK' })),
    };
    const svc = new NotificationsService(prisma as never, provider as never, {
      ...liveCaps,
      emailTransport: { host: 'smtp.example.com', port: 587, secure: false, from: 'svc@example.com', user: 'sv…@example.com' },
    });
    const r = await svc.verifyEmail('me@example.com', 'u-1');
    expect(r.verified).toBe(true);
    expect(r.transportCheck.ok).toBe(true);
    expect(r.send?.to).toBe('me@example.com');
    expect(r.send?.response).toBe('250 OK');
    expect((provider.send.mock.calls[0] as unknown[])[0]).toMatchObject({ channel: 'EMAIL', recipient: 'me@example.com', templateKey: 'smtp_verification' });
    const row = [...prisma._logs.values()][0] as { status: string; entityType: string; templateKey: string };
    expect(row.status).toBe('SENT');
    expect(row.entityType).toBe('System');
    expect(row.templateKey).toBe('smtp_verification');
  });

  it('reports FAIL with the reason when the mail server rejects the login', async () => {
    const prisma = makePrisma();
    const provider = {
      verify: vi.fn(async () => ({ ok: false, detail: 'Invalid login: 535 Authentication failed' })),
      send: vi.fn(async () => ({ success: false, failureReason: 'Invalid login: 535 Authentication failed' })),
    };
    const svc = new NotificationsService(prisma as never, provider as never, liveCaps);
    const r = await svc.verifyEmail('me@example.com', 'u-1');
    expect(r.verified).toBe(false);
    expect(r.transportCheck.detail).toMatch(/535/);
    expect(r.send?.success).toBe(false);
  });
});
