import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerNotificationsService } from '../customer-notifications.service';
import { NotificationTemplateStore } from '../templates/template-store.service';
import { CommunicationPreferenceService } from '../communication-preference.service';
import { PERMISSIONS } from '../../../common/constants/permissions';
import type { NotificationCapabilities } from '../providers/notification-provider.interface';

/**
 * CR-2026-096 — unified customer notifications: send semantics, master-data
 * protection, opt-out, duplicate guard, idempotency, test routing, contact status.
 *
 * CR-2026-112 — email only. The same guarantees, one channel: a send that names
 * another channel is refused rather than quietly treated as an email, and a
 * customer with no address on file gets the operational sentence, not silence.
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

const TEMPLATE_EMAIL = {
  id: 'tpl-1',
  key: 'SERVICE_DUE_EMAIL',
  reason: 'SERVICE_DUE',
  channel: 'EMAIL',
  name: 'Service due reminder',
  subject: 'Service Reminder — {{registrationNumber}}',
  body: "Hi {{customerFirstName}}, your {{vehicleDescription}} ({{registrationNumber}}) is due for servicing at Bert's Service Centre. Please contact us or book your service at your convenience. Thank you.",
  enabled: true,
  version: 3,
  // CR-2026-113 — SERVICE_DUE is a campaign: optional outreach.
  purpose: 'MARKETING',
};

function build(opts?: {
  caps?: Partial<NotificationCapabilities>;
  providerResult?: { success: boolean; providerReference?: string; failureReason?: string };
  providerThrows?: boolean;
  existingLogs?: Record<string, unknown>;
  optedOutEmail?: boolean;
  noEmailOnFile?: boolean;
}) {
  const createdLogs: Array<Record<string, unknown>> = [];
  let logSeq = 0;

  const prisma: Record<string, unknown> = {
    customer: {
      findUnique: vi.fn(async () => ({
        ...CUSTOMER,
        email: opts?.noEmailOnFile ? null : CUSTOMER.email,
        notificationOptInEmail: opts?.optedOutEmail ? false : CUSTOMER.notificationOptInEmail,
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
      // CR-2026-113 — honours the REASON as well as the channel: a mock that
      // returned the service-due template for every reason would have made a
      // ready-for-collection message look like a marketing campaign.
      findFirst: vi.fn(async ({ where }: { where: { channel: string; reason?: string } }) => {
        if (where.channel !== 'EMAIL') return null;
        if (!where.reason || where.reason === 'SERVICE_DUE') return TEMPLATE_EMAIL;
        return {
          ...TEMPLATE_EMAIL,
          id: `tpl-${where.reason}`,
          key: `${where.reason}_EMAIL`,
          reason: where.reason,
          purpose: where.reason === 'APPOINTMENT_REMINDER' ? 'REMINDER' : 'TRANSACTIONAL',
        };
      }),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tpl-new', version: 1, ...data })),
      findMany: vi.fn(async () => [TEMPLATE_EMAIL]),
      update: vi.fn(),
    },
    businessRuleConfig: {
      // CR-2026-113 — no row: the store falls back to the factory policy.
      findFirst: vi.fn(async () => null),
    },
    // CR-2026-114 — the RECORDED preference. `optedOutEmail` in these fixtures
    // means a customer who actively declined; the absence of an answer is its
    // own state and is covered in communication-preference.spec.ts.
    customerCommunicationPreference: {
      findUnique: vi.fn(async () => ({ status: opts?.optedOutEmail ? 'DECLINED' : 'ALLOWED' })),
      findMany: vi.fn(async () => []),
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
    emailConfigured: true,
    mode: 'LIVE',
    ...opts?.caps,
  };

  const service = new CustomerNotificationsService(
    prisma as never,
    audit as never,
    provider as never,
    caps,
    new NotificationTemplateStore(prisma as never),
    new CommunicationPreferenceService(prisma as never, audit as never),
  );

  return { service, prisma, provider, audit, createdLogs };
}

const SEND_BASE = {
  reason: 'SERVICE_DUE' as const,
  customerId: 'cust-1',
  vehicleId: 'veh-1',
  recommendationId: 'rec-1',
};

const EMAIL = (body: string, recipient = 'vw@example.com') => ({
  recipient,
  subject: 'Service Reminder — 1234 AB',
  body,
});

describe('compose', () => {
  it('generates the service-due email from the stored template with real vehicle facts', async () => {
    const { service } = build();
    const res = await service.compose({ reason: 'SERVICE_DUE', customerId: 'cust-1', vehicleId: 'veh-1', recommendationId: 'rec-1' });
    expect(res.email!.body).toContain('Hi Vincent, your 2020 Honda Grace (1234 AB) is due for servicing');
    expect(res.email!.subject).toBe('Service Reminder — 1234 AB');
    expect(res.email!.templateVersion).toBe(3);
    expect(res.customer.emailValid).toBe(true);
    expect(res.customer.emailProblem).toBeNull();
    expect(res.serviceDue!.serviceName).toBe('Oil Change');
  });

  /** CR-2026-112 §1 — no channel to choose, so nothing to choose it with. */
  it('offers no SMS draft, no SMS validity and no SMS capability flag', async () => {
    const { service } = build();
    const res = await service.compose({ reason: 'SERVICE_DUE', customerId: 'cust-1', vehicleId: 'veh-1' });
    expect(res).not.toHaveProperty('sms');
    expect(res.customer).not.toHaveProperty('smsValid');
    expect(res.customer).not.toHaveProperty('allowSms');
    expect(res.capabilities).not.toHaveProperty('smsConfigured');
  });

  /** CR-2026-112 §8 — the exact operational sentence, carried to the screen. */
  it('names the missing email address instead of offering another channel', async () => {
    const { service } = build({ noEmailOnFile: true });
    const res = await service.compose({ reason: 'SERVICE_DUE', customerId: 'cust-1', vehicleId: 'veh-1' });
    expect(res.customer.emailValid).toBe(false);
    expect(res.customer.emailProblem).toMatch(/No customer email address is recorded/);
    expect(res.customer.emailProblem).not.toMatch(/SMS|text/i);
  });
});

describe('send', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the EDITED body — exactly what staff approved — and snapshots both versions', async () => {
    const { service, provider, createdLogs } = build();
    const edited = 'Hi Vincent, your 2020 Honda Grace (1234 AB) is due — special note added. Thank you.';
    const res = await service.send({ ...SEND_BASE, email: EMAIL(edited) }, 'user-1');
    expect(res.sent[0].status).toBe('SENT');
    expect(res.sent[0].channel).toBe('EMAIL');
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'EMAIL', body: edited }));
    expect(createdLogs[0].body).toBe(edited);
    expect(createdLogs[0].generatedBody).toContain('is due for servicing');
    expect(createdLogs[0].templateVersion).toBe(3);
  });

  /** CR-2026-112 §9/§11 — an unsendable channel fails loudly and sends nothing. */
  it('REFUSES a send that asks for SMS rather than treating it as an email', async () => {
    const { service, provider, createdLogs } = build();
    await expect(
      service.send({ ...SEND_BASE, channels: ['SMS'], email: EMAIL('Hi Vincent.') }, 'user-1'),
    ).rejects.toThrow(/email only/i);
    expect(provider.send).not.toHaveBeenCalled();
    expect(createdLogs).toHaveLength(0);
  });

  it('accepts an explicit EMAIL channel from an older client', async () => {
    const { service } = build();
    const res = await service.send({ ...SEND_BASE, channels: ['EMAIL'], email: EMAIL('Hi Vincent.') }, 'user-1');
    expect(res.sent[0].status).toBe('SENT');
  });

  it('a send-to override NEVER touches the customer master record', async () => {
    const { service, prisma } = build();
    await service.send({ ...SEND_BASE, email: EMAIL('Hi Vincent, message.', 'other@example.com') }, 'user-1');
    expect((prisma.customer as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
  });

  it('blocks a missing address with the operational sentence, not a channel suggestion', async () => {
    const { service } = build({ noEmailOnFile: true });
    await expect(
      service.send({ ...SEND_BASE, email: EMAIL('Hi.', '') }, 'user-1'),
    ).rejects.toThrow(/No customer email address is recorded/);
  });

  it('blocks a malformed address and quotes it back', async () => {
    const { service } = build();
    await expect(
      service.send({ ...SEND_BASE, email: EMAIL('Hi.', 'not-an-address') }, 'user-1'),
    ).rejects.toThrow(/not a valid email address/);
  });

  it('blocks an empty subject', async () => {
    const { service } = build();
    await expect(
      service.send({ ...SEND_BASE, email: { recipient: 'vw@example.com', subject: '  ', body: 'Hi.' } }, 'user-1'),
    ).rejects.toThrow(/subject is empty/);
  });

  it('blocks a final message that still contains unresolved placeholders', async () => {
    const { service } = build();
    await expect(
      service.send({ ...SEND_BASE, email: EMAIL('Hi {{customerFirstName}}, due.') }, 'user-1'),
    ).rejects.toThrow(/unfilled placeholders/);
  });

  /**
   * CR-2026-113 — consent applies to OPTIONAL outreach. SERVICE_DUE is a
   * campaign, so an opted-out customer is blocked; overriding is exceptional,
   * manager-only, reason-required and audited.
   */
  it('blocks an optional campaign to a customer who declined it', async () => {
    const { service, provider } = build({ optedOutEmail: true });
    await expect(
      service.send({ ...SEND_BASE, email: EMAIL('Hi.') }, 'user-1', [PERMISSIONS.NOTIFY_SEND]),
    ).rejects.toThrow(/has declined optional email outreach/i);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('an advisor cannot override it — the exception belongs to a manager', async () => {
    const { service, provider } = build({ optedOutEmail: true });
    await expect(
      service.send(
        { ...SEND_BASE, overrideOptOut: true, overrideReason: 'Customer asked by phone today', email: EMAIL('Hi.') },
        'advisor-1',
        [PERMISSIONS.NOTIFY_SEND],
      ),
    ).rejects.toThrow(/manager/i);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('a manager must give a reason, and it is recorded against the message', async () => {
    const manager = [PERMISSIONS.NOTIFY_SEND, PERMISSIONS.NOTIFY_CONSENT_OVERRIDE];
    const { service, createdLogs, audit } = build({ optedOutEmail: true });

    await expect(
      service.send({ ...SEND_BASE, overrideOptOut: true, overrideReason: 'ok', email: EMAIL('Hi.') }, 'mgr-1', manager),
    ).rejects.toThrow(/reason/i);

    const res = await service.send(
      {
        ...SEND_BASE,
        overrideOptOut: true,
        overrideReason: 'Customer asked us by phone this morning to send the offer',
        email: EMAIL('Hi.'),
      },
      'mgr-1',
      manager,
    );
    expect(res.sent[0].status).toBe('SENT');
    expect(createdLogs[0].consentOverridden).toBe(true);
    expect(createdLogs[0].consentOverrideReason).toMatch(/asked us by phone/);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'mgr-1',
        afterJson: expect.objectContaining({ consentOverridden: true, purpose: 'MARKETING' }),
      }),
    );
  });

  /** The whole point of CR-2026-113: routine work needs no override at all. */
  it('an operational message needs NO override for the same opted-out customer', async () => {
    const { service, createdLogs } = build({ optedOutEmail: true });
    const res = await service.send(
      {
        reason: 'PICKUP_READY',
        customerId: 'cust-1',
        vehicleId: 'veh-1',
        email: EMAIL('Your vehicle is ready.'),
      },
      'advisor-1',
      [PERMISSIONS.NOTIFY_SEND],
    );
    expect(res.sent[0].status).toBe('SENT');
    expect(createdLogs[0].purpose).toBe('TRANSACTIONAL');
    expect(createdLogs[0].consentOverridden).toBe(false);
  });


  it('provider failure is recorded as FAILED — never shown as delivered', async () => {
    const { service, createdLogs } = build({ providerResult: { success: false, failureReason: 'rejected' } });
    const res = await service.send({ ...SEND_BASE, email: EMAIL('Hi Vincent.') }, 'user-1');
    expect(res.sent[0].status).toBe('FAILED');
    expect(res.sent[0].displayState).toBe('FAILED');
    expect(createdLogs[0].status).toBe('FAILED');
    expect(createdLogs[0].failureReason).toBe('rejected');
  });

  it('a provider exception is caught and recorded as FAILED', async () => {
    const { service, createdLogs } = build({ providerThrows: true });
    const res = await service.send({ ...SEND_BASE, email: EMAIL('Hi Vincent.') }, 'user-1');
    expect(res.sent[0].status).toBe('FAILED');
    expect(createdLogs[0].failureReason).toBe('network down');
  });

  it('double-click with the same clientRequestId does not send twice', async () => {
    const { service, provider } = build({
      existingLogs: { id: 'log-prev', status: 'SENT', channel: 'EMAIL', recipient: 'vw@example.com' },
    });
    const res = await service.send({ ...SEND_BASE, clientRequestId: 'req-abc', email: EMAIL('Hi.') }, 'user-1');
    expect(res.duplicate).toBe(true);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('successful SERVICE_DUE send marks the recommendation CONTACTED (never on mere composer open)', async () => {
    const { service, prisma } = build();
    await service.send({ ...SEND_BASE, email: EMAIL('Hi Vincent, due.') }, 'user-1');
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
    await service.send({ ...SEND_BASE, email: EMAIL('Hi Vincent.') }, 'user-1');
    expect((prisma.maintenanceRecommendation as { updateMany: ReturnType<typeof vi.fn> }).updateMany).not.toHaveBeenCalled();
  });
});

describe('duplicate ready-for-collection guard', () => {
  it('warns (409) when a notice was already sent; resend allowed with explicit confirm', async () => {
    const prior = { id: 'log-old', channel: 'EMAIL', status: 'SENT', sentAt: new Date(), createdAt: new Date() };
    const { service, prisma } = build();
    const visitFind = (prisma.serviceVisit as { findUnique: ReturnType<typeof vi.fn> }).findUnique;
    visitFind.mockResolvedValue({
      id: 'visit-1', status: 'READY_FOR_PICKUP', vehicleId: 'veh-1', customerId: 'cust-1',
      queueTicket: { ticketNumber: 'A007' },
    });
    const logFind = (prisma.notificationLog as { findFirst: ReturnType<typeof vi.fn> }).findFirst;
    // No clientRequestId in this test → the first findFirst IS the duplicate check.
    logFind.mockResolvedValueOnce(prior);

    await expect(
      service.send(
        {
          reason: 'PICKUP_READY', customerId: 'cust-1', serviceVisitId: 'visit-1',
          email: EMAIL('Ready.'),
        },
        'user-1',
      ),
    ).rejects.toThrow(/already sent/);

    logFind.mockResolvedValue(null);
    const ok = await service.send(
      {
        reason: 'PICKUP_READY', customerId: 'cust-1', serviceVisitId: 'visit-1',
        confirmDuplicate: true, email: EMAIL('Ready.'),
      },
      'user-1',
    );
    expect(ok.sent[0].status).toBe('SENT');
  });
});

describe('test routing', () => {
  it('TEST mode redirects to the test mailbox and retains the intended recipient', async () => {
    const { service, provider, createdLogs } = build({
      caps: { mode: 'TEST', testEmailTo: 'uat@berts.example' },
    });
    const res = await service.send({ ...SEND_BASE, email: EMAIL('Hi Vincent.') }, 'user-1');
    expect(res.sent[0].testRouted).toBe(true);
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ recipient: 'uat@berts.example' }));
    expect(createdLogs[0].recipient).toBe('uat@berts.example');
    expect(createdLogs[0].intendedRecipient).toBe('vw@example.com');
    expect(createdLogs[0].testRouted).toBe(true);
  });

  it('LIVE mode sends to the real customer with no redirect', async () => {
    const { service, provider, createdLogs } = build({ caps: { mode: 'LIVE' } });
    await service.send({ ...SEND_BASE, email: EMAIL('Hi Vincent.') }, 'user-1');
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ recipient: 'vw@example.com' }));
    expect(createdLogs[0].testRouted).toBe(false);
    expect(createdLogs[0].intendedRecipient).toBeNull();
  });

  it('a REAL mailbox in TEST mode with no test recipient refuses to send', async () => {
    const { service, provider } = build({ caps: { mode: 'TEST', emailConfigured: true, testEmailTo: undefined } });
    await expect(
      service.send({ ...SEND_BASE, email: EMAIL('Hi.') }, 'user-1'),
    ).rejects.toThrow(/TEST mode/);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('with no real mailbox the send is recorded as simulated, never claimed delivered', async () => {
    const { service, createdLogs } = build({ caps: { mode: 'LIVE', emailConfigured: false } });
    const res = await service.send({ ...SEND_BASE, email: EMAIL('Hi Vincent.') }, 'user-1');
    expect(res.sent[0].simulated).toBe(true);
    expect(res.sent[0].displayState).toBe('SIMULATED');
    expect(createdLogs[0].simulated).toBe(true);
  });
});

describe('templates', () => {
  it('rejects a template edit containing a placeholder outside the allow-list', async () => {
    const { service, prisma } = build();
    (prisma.notificationTemplate as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(TEMPLATE_EMAIL);
    await expect(
      service.updateTemplate('SERVICE_DUE_EMAIL', { body: 'Hi {{hackerData}}' }, 'user-1'),
    ).rejects.toThrow(/Unknown placeholders/);
  });

  it('a wording change bumps the version and is audited', async () => {
    const { service, prisma, audit } = build();
    const tpl = prisma.notificationTemplate as { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    tpl.findUnique.mockResolvedValue(TEMPLATE_EMAIL);
    tpl.update.mockResolvedValue({ ...TEMPLATE_EMAIL, body: 'New wording', version: 4 });
    await service.updateTemplate('SERVICE_DUE_EMAIL', { body: 'New wording' }, 'user-1');
    expect(tpl.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: { increment: 1 } }) }),
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'NOTIFICATION_TEMPLATE_UPDATED' }));
  });

  /** CR-2026-112 — legacy SMS rows are history: readable, never editable, never listed. */
  it('refuses to edit a legacy SMS template and lists EMAIL templates only', async () => {
    const { service, prisma } = build();
    const tpl = prisma.notificationTemplate as { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    tpl.findUnique.mockResolvedValue({ ...TEMPLATE_EMAIL, key: 'SERVICE_DUE_SMS', channel: 'SMS' });
    await expect(
      service.updateTemplate('SERVICE_DUE_SMS', { body: 'anything' }, 'user-1'),
    ).rejects.toThrow(/email only/i);

    await service.listTemplates();
    expect(tpl.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { channel: 'EMAIL' } }));
  });
});

describe('retry', () => {
  it('only FAILED notifications can be retried; the retry is a new auditable log row', async () => {
    const { service, prisma, provider, createdLogs, audit } = build();
    (prisma.notificationLog as Record<string, unknown>).findUnique = vi.fn(async () => ({
      id: 'log-old', status: 'FAILED', channel: 'EMAIL', templateKey: 'SERVICE_DUE_EMAIL', templateVersion: 3,
      recipient: 'vw@example.com', intendedRecipient: null, testRouted: false, simulated: false,
      reason: 'SERVICE_DUE', subject: 'Service Reminder', body: 'Hi Vincent.', generatedBody: 'Hi Vincent.',
      customerId: 'cust-1', vehicleId: 'veh-1', entityType: 'Customer', entityId: 'cust-1',
    }));
    const res = await service.retry('log-old', 'user-2');
    expect(res.status).toBe('SENT');
    expect(provider.send).toHaveBeenCalledOnce();
    expect(createdLogs.length).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CUSTOMER_NOTIFICATION_RETRIED' }));
  });

  /** CR-2026-112 — a failed legacy SMS row cannot be "retried" by a release with no SMS. */
  it('will not retry a message sent on a channel this release no longer has', async () => {
    const { service, prisma, provider } = build();
    (prisma.notificationLog as Record<string, unknown>).findUnique = vi.fn(async () => ({
      id: 'log-sms', status: 'FAILED', channel: 'SMS', templateKey: 'SERVICE_DUE_SMS', templateVersion: 1,
      recipient: '876-555-1111', body: 'Hi Vincent.', entityType: 'Customer', entityId: 'cust-1',
    }));
    await expect(service.retry('log-sms', 'user-2')).rejects.toThrow(/email only/i);
    expect(provider.send).not.toHaveBeenCalled();
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
