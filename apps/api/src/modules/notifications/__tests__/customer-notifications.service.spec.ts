import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerNotificationsService } from '../customer-notifications.service';
import type { NotificationCapabilities } from '../providers/notification-provider.interface';

/**
 * CR-2026-096 — unified customer notifications: send semantics, master-data
 * protection, opt-out, duplicate guard, idempotency, test routing, contact status.
 */

const CUSTOMER = {
  id: 'cust-1',
  firstName: 'Vincent',
  lastName: 'Wilson',
  phone: '876-555-1111',
  email: 'vw@example.com',
  notificationOptInSms: true,
  notificationOptInEmail: true,
};

const VEHICLE = {
  id: 'veh-1',
  customerId: 'cust-1',
  plateNumber: '1234 AB',
  make: 'Honda',
  model: 'Grace',
  modelYear: 2020,
  odometer: 49800,
};

const TEMPLATE_SMS = {
  id: 'tpl-1',
  key: 'SERVICE_DUE_SMS',
  reason: 'SERVICE_DUE',
  channel: 'SMS',
  name: 'Service due reminder (SMS)',
  subject: null,
  body: "Hi {{customerFirstName}}, your {{vehicleDescription}} ({{registrationNumber}}) is due for servicing at Bert's Service Centre. Please contact us or book your service at your convenience. Thank you.",
  enabled: true,
  version: 3,
};

function build(opts?: {
  caps?: Partial<NotificationCapabilities>;
  providerResult?: { success: boolean; providerReference?: string; failureReason?: string };
  providerThrows?: boolean;
  existingLogs?: Record<string, unknown>;
  optedOutSms?: boolean;
}) {
  const createdLogs: Array<Record<string, unknown>> = [];
  let logSeq = 0;

  const prisma: Record<string, unknown> = {
    customer: {
      findUnique: vi.fn(async () => ({
        ...CUSTOMER,
        notificationOptInSms: opts?.optedOutSms ? false : CUSTOMER.notificationOptInSms,
      })),
      update: vi.fn(),
    },
    vehicle: { findUnique: vi.fn(async () => VEHICLE) },
    serviceVisit: { findUnique: vi.fn(async () => null) },
    serviceType: { findFirst: vi.fn(async () => ({ name: 'Oil Change' })) },
    maintenanceRecommendation: {
      findUnique: vi.fn(async () => ({
        id: 'rec-1',
        vehicleId: 'veh-1',
        serviceTypeCode: 'OIL-01',
        nextDueDate: new Date('2026-09-03'),
        nextDueOdometer: 50000,
        basisDate: new Date('2026-06-01'),
        contactStatus: 'NOT_CONTACTED',
        lastContactedAt: null,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    notificationTemplate: {
      findFirst: vi.fn(async ({ where }: { where: { channel: string } }) =>
        where.channel === 'SMS' ? TEMPLATE_SMS : null,
      ),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tpl-new', version: 1, ...data })),
      findMany: vi.fn(async () => [TEMPLATE_SMS]),
      update: vi.fn(),
    },
    notificationLog: {
      findFirst: vi.fn(async () => opts?.existingLogs ?? null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `log-${++logSeq}`, ...data };
        createdLogs.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = createdLogs.find((l) => l.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
  };

  const provider = {
    send: vi.fn(async () => {
      if (opts?.providerThrows) throw new Error('network down');
      return opts?.providerResult ?? { success: true, providerReference: 'prov-123' };
    }),
  };

  const audit = { log: vi.fn(async () => undefined) };

  const caps: NotificationCapabilities = {
    smsConfigured: true,
    emailConfigured: false,
    mode: 'LIVE',
    ...opts?.caps,
  };

  const service = new CustomerNotificationsService(
    prisma as never,
    audit as never,
    provider as never,
    caps,
  );

  return { service, prisma, provider, audit, createdLogs };
}

const SEND_BASE = {
  reason: 'SERVICE_DUE' as const,
  customerId: 'cust-1',
  vehicleId: 'veh-1',
  recommendationId: 'rec-1',
  channels: ['SMS'] as Array<'SMS'>,
};

describe('compose', () => {
  it('generates the service-due SMS from the stored template with real vehicle facts', async () => {
    const { service } = build();
    const res = await service.compose({ reason: 'SERVICE_DUE', customerId: 'cust-1', vehicleId: 'veh-1', recommendationId: 'rec-1' });
    expect(res.sms!.body).toContain('Hi Vincent, your 2020 Honda Grace (1234 AB) is due for servicing');
    expect(res.sms!.templateVersion).toBe(3);
    expect(res.customer.smsValid).toBe(true);
    expect(res.serviceDue!.serviceName).toBe('Oil Change');
  });
});

describe('send', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the EDITED body — exactly what staff approved — and snapshots both versions', async () => {
    const { service, provider, createdLogs } = build();
    const edited = 'Hi Vincent, your 2020 Honda Grace (1234 AB) is due — special note added. Thank you.';
    const res = await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-1111', body: edited } },
      'user-1',
    );
    expect(res.sent[0].status).toBe('SENT');
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ body: edited }));
    expect(createdLogs[0].body).toBe(edited);
    expect(createdLogs[0].generatedBody).toContain('is due for servicing');
    expect(createdLogs[0].templateVersion).toBe(3);
  });

  it('a send-to override NEVER touches the customer master record', async () => {
    const { service, prisma } = build();
    await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-2222', body: 'Hi Vincent, message.' } },
      'user-1',
    );
    expect((prisma.customer as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
  });

  it('blocks an invalid mobile number with a clear message', async () => {
    const { service } = build();
    await expect(
      service.send({ ...SEND_BASE, sms: { recipient: '12', body: 'Hi.' } }, 'user-1'),
    ).rejects.toThrow('No valid mobile number available.');
  });

  it('blocks a final message that still contains unresolved placeholders', async () => {
    const { service } = build();
    await expect(
      service.send(
        { ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi {{customerFirstName}}, due.' } },
        'user-1',
      ),
    ).rejects.toThrow(/unfilled placeholders/);
  });

  it('respects a recorded SMS opt-out unless staff explicitly confirm', async () => {
    const { service, provider } = build({ optedOutSms: true });
    await expect(
      service.send({ ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi.' } }, 'user-1'),
    ).rejects.toThrow(/opted out/);
    expect(provider.send).not.toHaveBeenCalled();

    const ok = await service.send(
      { ...SEND_BASE, overrideOptOut: true, sms: { recipient: '876-555-1111', body: 'Hi.' } },
      'user-1',
    );
    expect(ok.sent[0].status).toBe('SENT');
  });

  it('provider failure is recorded as FAILED — never shown as delivered', async () => {
    const { service, createdLogs } = build({ providerResult: { success: false, failureReason: 'rejected' } });
    const res = await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi Vincent.' } },
      'user-1',
    );
    expect(res.sent[0].status).toBe('FAILED');
    expect(createdLogs[0].status).toBe('FAILED');
    expect(createdLogs[0].failureReason).toBe('rejected');
  });

  it('a provider exception is caught and recorded as FAILED', async () => {
    const { service, createdLogs } = build({ providerThrows: true });
    const res = await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi Vincent.' } },
      'user-1',
    );
    expect(res.sent[0].status).toBe('FAILED');
    expect(createdLogs[0].failureReason).toBe('network down');
  });

  it('double-click with the same clientRequestId does not send twice', async () => {
    const { service, provider } = build({
      existingLogs: { id: 'log-prev', status: 'SENT', channel: 'SMS', recipient: '876-555-1111' },
    });
    const res = await service.send(
      { ...SEND_BASE, clientRequestId: 'req-abc', sms: { recipient: '876-555-1111', body: 'Hi.' } },
      'user-1',
    );
    expect(res.duplicate).toBe(true);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('successful SERVICE_DUE send marks the recommendation CONTACTED (never on mere composer open)', async () => {
    const { service, prisma } = build();
    await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi Vincent, due.' } },
      'user-1',
    );
    const updateMany = (prisma.maintenanceRecommendation as { updateMany: ReturnType<typeof vi.fn> }).updateMany;
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contactStatus: { in: ['NOT_CONTACTED', 'CONTACTED'] } }),
        data: expect.objectContaining({ contactStatus: 'CONTACTED' }),
      }),
    );
  });

  it('a FAILED send does not mark the customer contacted', async () => {
    const { service, prisma } = build({ providerResult: { success: false, failureReason: 'nope' } });
    await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi Vincent.' } },
      'user-1',
    );
    expect((prisma.maintenanceRecommendation as { updateMany: ReturnType<typeof vi.fn> }).updateMany).not.toHaveBeenCalled();
  });
});

describe('duplicate pickup guard', () => {
  it('warns (409) when a pickup notice was already sent; resend allowed with explicit confirm', async () => {
    const prior = { id: 'log-old', channel: 'SMS', status: 'SENT', sentAt: new Date(), createdAt: new Date() };
    const { service, prisma } = build();
    const visitFind = (prisma.serviceVisit as { findUnique: ReturnType<typeof vi.fn> }).findUnique;
    visitFind.mockResolvedValue({
      id: 'visit-1', status: 'READY_FOR_PICKUP', vehicleId: 'veh-1', customerId: 'cust-1',
      queueTicket: { ticketNumber: 'A007' },
    });
    const logFind = (prisma.notificationLog as { findFirst: ReturnType<typeof vi.fn> }).findFirst;
    // No clientRequestId in this test → the first findFirst IS the duplicate-pickup check.
    logFind.mockResolvedValueOnce(prior);

    await expect(
      service.send(
        {
          reason: 'PICKUP_READY', customerId: 'cust-1', serviceVisitId: 'visit-1',
          channels: ['SMS'], sms: { recipient: '876-555-1111', body: 'Ready.' },
        },
        'user-1',
      ),
    ).rejects.toThrow(/already sent/);

    logFind.mockResolvedValue(null);
    const ok = await service.send(
      {
        reason: 'PICKUP_READY', customerId: 'cust-1', serviceVisitId: 'visit-1',
        channels: ['SMS'], confirmDuplicate: true, sms: { recipient: '876-555-1111', body: 'Ready.' },
      },
      'user-1',
    );
    expect(ok.sent[0].status).toBe('SENT');
  });
});

describe('test routing', () => {
  it('TEST mode redirects to the test recipient and retains the intended one', async () => {
    const { service, provider, createdLogs } = build({
      caps: { mode: 'TEST', testSmsTo: '876-999-0000' },
    });
    const res = await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi Vincent.' } },
      'user-1',
    );
    expect(res.sent[0].testRouted).toBe(true);
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ recipient: '876-999-0000' }));
    expect(createdLogs[0].recipient).toBe('876-999-0000');
    expect(createdLogs[0].intendedRecipient).toBe('876-555-1111');
    expect(createdLogs[0].testRouted).toBe(true);
  });

  it('LIVE mode sends to the real customer with no redirect', async () => {
    const { service, provider, createdLogs } = build({ caps: { mode: 'LIVE' } });
    await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi Vincent.' } },
      'user-1',
    );
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ recipient: '876-555-1111' }));
    expect(createdLogs[0].testRouted).toBe(false);
    expect(createdLogs[0].intendedRecipient).toBeNull();
  });

  it('a REAL provider in TEST mode with no test recipient refuses to send', async () => {
    const { service, provider } = build({ caps: { mode: 'TEST', smsConfigured: true, testSmsTo: undefined } });
    await expect(
      service.send({ ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi.' } }, 'user-1'),
    ).rejects.toThrow(/TEST mode/);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('with no real provider the send is recorded as simulated, never claimed delivered', async () => {
    const { service, createdLogs } = build({ caps: { mode: 'LIVE', smsConfigured: false } });
    const res = await service.send(
      { ...SEND_BASE, sms: { recipient: '876-555-1111', body: 'Hi Vincent.' } },
      'user-1',
    );
    expect(res.sent[0].simulated).toBe(true);
    expect(createdLogs[0].simulated).toBe(true);
  });
});

describe('templates', () => {
  it('rejects a template edit containing a placeholder outside the allow-list', async () => {
    const { service, prisma } = build();
    (prisma.notificationTemplate as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(TEMPLATE_SMS);
    await expect(
      service.updateTemplate('SERVICE_DUE_SMS', { body: 'Hi {{hackerData}}' }, 'user-1'),
    ).rejects.toThrow(/Unknown placeholders/);
  });

  it('a wording change bumps the version and is audited', async () => {
    const { service, prisma, audit } = build();
    const tpl = prisma.notificationTemplate as { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    tpl.findUnique.mockResolvedValue(TEMPLATE_SMS);
    tpl.update.mockResolvedValue({ ...TEMPLATE_SMS, body: 'New wording', version: 4 });
    await service.updateTemplate('SERVICE_DUE_SMS', { body: 'New wording' }, 'user-1');
    expect(tpl.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: { increment: 1 } }) }),
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'NOTIFICATION_TEMPLATE_UPDATED' }));
  });
});

describe('retry', () => {
  it('only FAILED notifications can be retried; the retry is a new auditable log row', async () => {
    const { service, prisma, provider, createdLogs, audit } = build();
    const logFind = (prisma.notificationLog as { findUnique?: ReturnType<typeof vi.fn> });
    (prisma.notificationLog as Record<string, unknown>).findUnique = vi.fn(async () => ({
      id: 'log-old', status: 'FAILED', channel: 'SMS', templateKey: 'SERVICE_DUE_SMS', templateVersion: 3,
      recipient: '876-555-1111', intendedRecipient: null, testRouted: false, simulated: false,
      reason: 'SERVICE_DUE', subject: null, body: 'Hi Vincent.', generatedBody: 'Hi Vincent.',
      customerId: 'cust-1', vehicleId: 'veh-1', entityType: 'Customer', entityId: 'cust-1',
    }));
    void logFind;
    const res = await service.retry('log-old', 'user-2');
    expect(res.status).toBe('SENT');
    expect(provider.send).toHaveBeenCalledOnce();
    expect(createdLogs.length).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CUSTOMER_NOTIFICATION_RETRIED' }));
  });
});

describe('manual contact', () => {
  it('requires a note for method OTHER and records a MANUAL log row', async () => {
    const { service, createdLogs } = build();
    await expect(
      service.markManualContact(
        { customerId: 'cust-1', reason: 'PICKUP_READY', method: 'OTHER' },
        'user-1',
      ),
    ).rejects.toThrow(/note is required/);

    const ok = await service.markManualContact(
      { customerId: 'cust-1', reason: 'PICKUP_READY', method: 'PHONE_CALL' },
      'user-1',
    );
    expect(ok.logId).toBeDefined();
    expect(createdLogs[0].channel).toBe('MANUAL_CALL');
    expect(createdLogs[0].status).toBe('MANUAL');
  });
});
