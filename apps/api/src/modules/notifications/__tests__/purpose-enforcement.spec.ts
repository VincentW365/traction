import { describe, it, expect, vi } from 'vitest';
import { CustomerNotificationsService } from '../customer-notifications.service';
import { NotificationTemplateStore } from '../templates/template-store.service';
import { CommunicationPreferenceService } from '../communication-preference.service';
import { NotificationRoutingService } from '../notification-routing.service';
import { CONSENT_POLICY_RULE_KEY } from '../consent-policy';
import { PERMISSIONS } from '../../../common/constants/permissions';
import type { NotificationCapabilities } from '../providers/notification-provider.interface';

/**
 * CR-2026-114 §8 — every purpose, verified independently, against a customer
 * who has NOT opted in.
 *
 * This is the matrix that matters operationally: with the imported base opted
 * out almost entirely, any purpose that is wrongly classed as marketing stops
 * reaching customers, and any campaign wrongly classed as operational reaches
 * people who never agreed to it. Both failures are silent without this table.
 */

const CUSTOMER = {
  id: 'cust-1',
  firstName: 'Vincent',
  lastName: 'Wilson',
  phone: '876-555-1111',
  email: 'vw@example.com',
  notificationOptInSms: false,
  notificationOptInEmail: false, // the imported state: no recorded agreement
};

const VEHICLE = { id: 'veh-1', customerId: 'cust-1', plateNumber: '1234 AB', make: 'Honda', model: 'Grace', modelYear: 2020, odometer: 1 };

function templateFor(reason: string) {
  const purpose =
    reason === 'SERVICE_DUE' ? 'MARKETING' : reason === 'APPOINTMENT_REMINDER' ? 'REMINDER' : 'TRANSACTIONAL';
  return {
    id: `tpl-${reason}`,
    key: `${reason}_EMAIL`,
    reason,
    channel: 'EMAIL',
    name: reason,
    subject: 'Subject',
    body: 'Hi {{customerFirstName}}, this is the message.',
    enabled: true,
    version: 1,
    purpose,
  };
}

function build(opts?: { preference?: 'UNKNOWN' | 'ALLOWED' | 'DECLINED'; policy?: string[] }) {
  const createdLogs: Array<Record<string, unknown>> = [];
  const prisma: Record<string, unknown> = {
    customer: { findUnique: vi.fn(async () => CUSTOMER), update: vi.fn() },
    vehicle: { findUnique: vi.fn(async () => VEHICLE) },
    serviceVisit: { findUnique: vi.fn(async () => null) },
    serviceType: { findFirst: vi.fn(async () => null) },
    maintenanceRecommendation: { findUnique: vi.fn(async () => null), updateMany: vi.fn() },
    notificationTemplate: {
      findFirst: vi.fn(async ({ where }: { where: { reason: string } }) => templateFor(where.reason)),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
    },
    businessRuleConfig: {
      // Answer only the key that was asked for. A fake that returns the consent
      // policy for every rule hands the wrong shape to any other rule read.
      findFirst: vi.fn(async (args?: { where?: { ruleKey?: string } }) =>
        args?.where?.ruleKey === CONSENT_POLICY_RULE_KEY && opts?.policy ? { valueJson: opts.policy } : null,
      ),
    },
    customerCommunicationPreference: {
      findUnique: vi.fn(async () => ({ status: opts?.preference ?? 'UNKNOWN' })),
      findMany: vi.fn(async () => []),
    },
    notificationLog: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `log-${createdLogs.length + 1}`, ...data };
        createdLogs.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const provider = { send: vi.fn(async () => ({ success: true, providerReference: 'p1' })) };
  const audit = { log: vi.fn(async () => undefined) };
  const caps: NotificationCapabilities = { emailConfigured: true, mode: 'LIVE' };
  const service = new CustomerNotificationsService(
    prisma as never,
    audit as never,
    provider as never,
    caps,
    new NotificationTemplateStore(prisma as never),
    new CommunicationPreferenceService(prisma as never, audit as never),
    // CR-2026-117 — the real resolver over a rule table with no rows, so these
    // specs exercise the environment fallback rather than a stub of it.
    new NotificationRoutingService(prisma as never),
  );
  return { service, provider, createdLogs, audit };
}

const EMAIL = { recipient: 'vw@example.com', subject: 'Subject', body: 'Hi Vincent, this is the message.' };
const send = (
  reason: string,
  service: CustomerNotificationsService,
  perms: string[] = [PERMISSIONS.NOTIFY_SEND],
  extra: Record<string, unknown> = {},
) =>
  service.send({ reason: reason as never, customerId: 'cust-1', vehicleId: 'veh-1', email: EMAIL, ...extra }, 'user-1', perms);

describe('TRANSACTIONAL — reaches a customer with no recorded agreement', () => {
  const reasons = [
    'APPOINTMENT_CONFIRMATION',
    'APPOINTMENT_CHANGED',
    'APPOINTMENT_CANCELLED',
    'CUSTOMER_ACTION_REQUIRED',
    'QUEUE_CHECKED_IN',
    'QUEUE_WORK_STARTED',
    'QUEUE_UPDATE',
    'PICKUP_READY',
  ];

  it.each(reasons)('%s sends without any override', async (reason) => {
    const { service, provider, createdLogs } = build({ preference: 'UNKNOWN' });
    const res = await send(reason, service);
    expect(res.sent[0].status).toBe('SENT');
    expect(provider.send).toHaveBeenCalledOnce();
    expect(createdLogs[0].purpose).toBe('TRANSACTIONAL');
    expect(createdLogs[0].consentOverridden).toBe(false);
  });

  it.each(reasons)('%s sends even to a customer who DECLINED optional email', async (reason) => {
    const { service } = build({ preference: 'DECLINED' });
    const res = await send(reason, service);
    expect(res.sent[0].status).toBe('SENT');
  });
});

describe('REMINDER — about a booking they made', () => {
  it('sends without consent under the default policy', async () => {
    const { service, createdLogs } = build({ preference: 'UNKNOWN' });
    const res = await send('APPOINTMENT_REMINDER', service);
    expect(res.sent[0].status).toBe('SENT');
    expect(createdLogs[0].purpose).toBe('REMINDER');
  });

  /** §8 — the setting must change ENFORCEMENT, not just the settings screen. */
  it('is blocked once the business adds REMINDER to the consent policy', async () => {
    const { service, provider } = build({ preference: 'UNKNOWN', policy: ['MARKETING', 'REMINDER'] });
    await expect(send('APPOINTMENT_REMINDER', service)).rejects.toThrow(/no recorded preference|declined/i);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('and an operational message is still not gated by that same policy', async () => {
    const { service } = build({ preference: 'UNKNOWN', policy: ['MARKETING', 'REMINDER'] });
    const res = await send('PICKUP_READY', service);
    expect(res.sent[0].status).toBe('SENT');
  });
});

describe('MARKETING — optional outreach', () => {
  it('is blocked for an UNKNOWN preference, and says so accurately', async () => {
    const { service, provider } = build({ preference: 'UNKNOWN' });
    await expect(send('SERVICE_DUE', service)).rejects.toThrow(/no recorded preference/i);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('is blocked for a DECLINED preference, with the refusal wording', async () => {
    const { service } = build({ preference: 'DECLINED' });
    await expect(send('SERVICE_DUE', service)).rejects.toThrow(/has declined optional email outreach/i);
  });

  it('never suggests switching channel as a way round the preference', async () => {
    const { service } = build({ preference: 'DECLINED' });
    await expect(send('SERVICE_DUE', service)).rejects.toThrow(
      /use an approved customer-contact method in accordance with/i,
    );
    await expect(send('SERVICE_DUE', service)).rejects.not.toThrow(/log the call|call the customer instead/i);
  });

  it('sends freely once the customer has ALLOWED it', async () => {
    const { service, createdLogs } = build({ preference: 'ALLOWED' });
    const res = await send('SERVICE_DUE', service);
    expect(res.sent[0].status).toBe('SENT');
    expect(createdLogs[0].purpose).toBe('MARKETING');
    expect(createdLogs[0].consentOverridden).toBe(false);
  });

  it('is released for everyone if the business empties the consent policy', async () => {
    // parsePurposePolicy refuses an empty list and keeps the factory policy, so
    // "release everything" takes a deliberate, valid setting — not a typo.
    const { service } = build({ preference: 'UNKNOWN', policy: ['TRANSACTIONAL'] });
    const res = await send('SERVICE_DUE', service);
    expect(res.sent[0].status).toBe('SENT');
  });

  describe('the override', () => {
    it('is refused to an advisor', async () => {
      const { service } = build({ preference: 'DECLINED' });
      await expect(
        send('SERVICE_DUE', service, [PERMISSIONS.NOTIFY_SEND], {
          overrideOptOut: true,
          overrideReason: 'Customer asked for this by phone today',
        }),
      ).rejects.toThrow(/manager/i);
    });

    it('needs a meaningful reason from a manager', async () => {
      const manager = [PERMISSIONS.NOTIFY_SEND, PERMISSIONS.NOTIFY_CONSENT_OVERRIDE];
      const { service } = build({ preference: 'DECLINED' });
      await expect(
        send('SERVICE_DUE', service, manager, { overrideOptOut: true, overrideReason: 'ok' }),
      ).rejects.toThrow(/at least 10 characters/i);
    });

    it('records actor, reason, timestamp, purpose and the preference it stepped over', async () => {
      const manager = [PERMISSIONS.NOTIFY_SEND, PERMISSIONS.NOTIFY_CONSENT_OVERRIDE];
      const { service, createdLogs, audit } = build({ preference: 'DECLINED' });
      const res = await send('SERVICE_DUE', service, manager, {
        overrideOptOut: true,
        overrideReason: 'Customer phoned this morning asking for the offer',
      });
      expect(res.sent[0].status).toBe('SENT');
      expect(createdLogs[0]).toMatchObject({
        purpose: 'MARKETING',
        consentOverridden: true,
        initiatedByUserId: 'user-1',
      });
      expect(createdLogs[0].consentOverrideReason).toMatch(/phoned this morning/);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-1',
          afterJson: expect.objectContaining({
            purpose: 'MARKETING',
            consentOverridden: true,
            customerPreference: 'DECLINED',
            consentOverrideReason: expect.stringMatching(/phoned this morning/),
          }),
        }),
      );
    });
  });
});
