import { describe, it, expect, vi } from 'vitest';
import { CommunicationPreferenceService } from '../communication-preference.service';
import { decideConsent, PREFERENCE_LABELS } from '../consent-policy';
import { pickupToCollection, placeholderDrift, transformWording } from '../templates/wording-transform';

/**
 * CR-2026-114 §6/§8 — "nobody asked" is a third state, and it must never be
 * presented, stored or acted on as if the customer had refused.
 */

function build(existing?: { status: string; source?: string } | null) {
  const rows: Array<Record<string, unknown>> = [];
  const customerUpdates: Array<Record<string, unknown>> = [];
  const tx = {
    customerCommunicationPreference: {
      upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        rows.push(existing ? args.update : args.create);
        return {};
      }),
    },
    customer: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        customerUpdates.push(args.data);
        return {};
      }),
    },
  };
  const prisma = {
    customerCommunicationPreference: {
      findUnique: vi.fn(async () => (existing === undefined ? null : existing)),
      findMany: vi.fn(async () => []),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const service = new CommunicationPreferenceService(prisma as never, audit as never);
  return { service, prisma, audit, rows, customerUpdates, tx };
}

describe('the absence of an answer', () => {
  it('reads as UNKNOWN when no preference has ever been recorded', async () => {
    const { service } = build(null);
    expect(await service.statusFor('cust-1', 'MARKETING')).toBe('UNKNOWN');
  });

  it('reads as UNKNOWN when the lookup itself fails — never as permission', async () => {
    const { service, prisma } = build(null);
    prisma.customerCommunicationPreference.findUnique.mockRejectedValue(new Error('db down'));
    expect(await service.statusFor('cust-1', 'MARKETING')).toBe('UNKNOWN');
  });

  it('is NOT a refusal: it blocks marketing but is described differently', () => {
    const unknown = decideConsent({ purpose: 'MARKETING', preference: 'UNKNOWN', purposesRequiringConsent: ['MARKETING'] });
    const declined = decideConsent({ purpose: 'MARKETING', preference: 'DECLINED', purposesRequiringConsent: ['MARKETING'] });

    expect(unknown.allowed).toBe(false);
    expect(declined.allowed).toBe(false);
    // Same outcome, different truth — and the wording says so.
    expect(unknown.blockedReason).not.toBe(declined.blockedReason);
    expect(unknown.blockedReason).toMatch(/no recorded preference|nobody has asked/i);
    expect(declined.blockedReason).toMatch(/has declined/i);
    expect(unknown.blockedReason).not.toMatch(/has declined/i);
  });

  it('never blocks an operational message, whatever the preference says', () => {
    for (const preference of ['UNKNOWN', 'ALLOWED', 'DECLINED'] as const) {
      const d = decideConsent({ purpose: 'TRANSACTIONAL', preference, purposesRequiringConsent: ['MARKETING'] });
      expect(d.allowed, preference).toBe(true);
    }
  });

  it('is labelled for staff without database words', () => {
    expect(PREFERENCE_LABELS.UNKNOWN).toBe('Preference unknown');
    expect(PREFERENCE_LABELS.ALLOWED).toBe('Allowed');
    expect(PREFERENCE_LABELS.DECLINED).toBe('Declined');
    for (const label of Object.values(PREFERENCE_LABELS)) {
      expect(label).not.toMatch(/opt|notificationOptIn|true|false/i);
    }
  });
});

describe('capturing an answer', () => {
  it('records the answer, the moment, the actor and the provenance', async () => {
    const { service, rows, audit } = build(null);
    const res = await service.capture({
      customerId: 'cust-1',
      purpose: 'MARKETING',
      status: 'DECLINED',
      source: 'CUSTOMER_PROFILE',
      actorUserId: 'user-9',
      note: 'Told us at the counter',
    });
    expect(res).toMatchObject({ changed: true, from: 'UNKNOWN', to: 'DECLINED' });
    expect(rows[0]).toMatchObject({ status: 'DECLINED', source: 'CUSTOMER_PROFILE', capturedByUserId: 'user-9' });
    expect(rows[0].capturedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMER_COMMUNICATION_PREFERENCE_UPDATED',
        actorUserId: 'user-9',
        beforeJson: expect.objectContaining({ status: 'UNKNOWN' }),
        afterJson: expect.objectContaining({ status: 'DECLINED', source: 'CUSTOMER_PROFILE' }),
      }),
    );
  });

  /** An imported UNKNOWN must not pretend to have a customer decision timestamp. */
  it('records NO capture date when setting a state back to UNKNOWN', async () => {
    const { service, rows } = build({ status: 'ALLOWED' });
    await service.capture({
      customerId: 'cust-1',
      purpose: 'MARKETING',
      status: 'UNKNOWN',
      source: 'STAFF_CAPTURED',
      actorUserId: 'user-9',
    });
    expect(rows[0].capturedAt).toBeNull();
  });

  it('keeps the legacy boolean in step — ALLOWED is the only permissive state', async () => {
    for (const [status, expected] of [
      ['ALLOWED', true],
      ['DECLINED', false],
      ['UNKNOWN', false],
    ] as const) {
      const { service, customerUpdates } = build({ status: status === 'ALLOWED' ? 'DECLINED' : 'ALLOWED' });
      await service.capture({ customerId: 'c', purpose: 'MARKETING', status, source: 'STAFF_CAPTURED' });
      expect(customerUpdates[0], status).toEqual({ notificationOptInEmail: expected });
    }
  });

  it('writes nothing when the answer has not changed — opening a screen is not a decision', async () => {
    const { service, rows, audit } = build({ status: 'ALLOWED' });
    const res = await service.capture({ customerId: 'c', purpose: 'MARKETING', status: 'ALLOWED', source: 'STAFF_CAPTURED' });
    expect(res.changed).toBe(false);
    expect(rows).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('a staff tickbox that was changed is an answer either way', async () => {
    const on = build(null);
    await on.service.captureFromStaffTickbox({ customerId: 'c', agreed: true, actorUserId: 'u' });
    expect(on.rows[0]).toMatchObject({ status: 'ALLOWED', source: 'STAFF_CAPTURED' });

    const off = build({ status: 'ALLOWED' });
    await off.service.captureFromStaffTickbox({ customerId: 'c', agreed: false, actorUserId: 'u' });
    expect(off.rows[0]).toMatchObject({ status: 'DECLINED', source: 'STAFF_CAPTURED' });
  });
});

/**
 * CR-2026-114 §8 — the regression for the bug CR-2026-113 found in its own
 * tooling: a wording change must never rewrite a template variable.
 */
describe('template wording transformations', () => {
  it('changes prose and leaves {{placeholders}} byte-for-byte alone', () => {
    const before = 'Your {{vehicleDescription}} is ready for pickup.\n\n{{pickupDetails}}';
    const after = pickupToCollection(before);
    expect(after).toContain('ready for collection.');
    expect(after).toContain('{{pickupDetails}}');
    expect(after).not.toContain('{{collectionDetails}}');
  });

  it('reports drift when a transformation DOES touch the vocabulary', () => {
    const before = 'Ready for pickup. {{pickupDetails}}';
    // The naive version of exactly the bug that shipped and was repaired.
    const naive = before.replace(/pickup/g, 'collection');
    const drift = placeholderDrift(before, naive);
    expect(drift.removed).toEqual(['{{pickupDetails}}']);
    expect(drift.added).toEqual(['{{collectionDetails}}']);
  });

  it('reports no drift for a safe transformation', () => {
    const before = 'Ready for pickup at {{siteName}}. {{pickupDetails}}';
    expect(placeholderDrift(before, pickupToCollection(before))).toEqual({ removed: [], added: [] });
  });

  it('protects placeholders from ANY prose transform, not just this one', () => {
    const shouty = transformWording('Hello {{customerFirstName}}, your car is ready.', (p) => p.toUpperCase());
    expect(shouty).toBe('HELLO {{customerFirstName}}, YOUR CAR IS READY.');
  });
});
