import { describe, it, expect } from 'vitest';
import {
  decideConsent,
  parsePurposePolicy,
  purposeForReason,
  purposeForTemplateKey,
  REASON_PURPOSE,
  DEFAULT_PURPOSES_REQUIRING_CONSENT,
} from '../consent-policy';
import { DEFAULT_TEMPLATES } from '../templates/default-templates';

/**
 * CR-2026-113 §1 — consent applies to optional outreach, not to the messages a
 * customer needs about their own booking or vehicle.
 *
 * The failure this prevents: an advisor having to "override" a customer's
 * preference to send an appointment confirmation. An override on the routine
 * path is not an override — it is a keystroke, and the preference it steps over
 * stops meaning anything.
 */

const POLICY = DEFAULT_PURPOSES_REQUIRING_CONSENT;

describe('what needs consent', () => {
  it('operational messages reach a customer who has not opted in', () => {
    for (const reason of [
      'APPOINTMENT_CONFIRMATION',
      'APPOINTMENT_CHANGED',
      'APPOINTMENT_CANCELLED',
      'CUSTOMER_ACTION_REQUIRED',
      'PICKUP_READY',
      'QUEUE_CHECKED_IN',
      'QUEUE_WORK_STARTED',
      'QUEUE_UPDATE',
    ] as const) {
      const decision = decideConsent({
        purpose: purposeForReason(reason),
        preference: 'UNKNOWN',
        purposesRequiringConsent: POLICY,
      });
      expect(decision.allowed, `${reason} should not need consent`).toBe(true);
      expect(decision.requiresConsent, reason).toBe(false);
    }
  });

  it('a reminder about an appointment the customer made is not optional outreach', () => {
    const decision = decideConsent({
      purpose: purposeForReason('APPOINTMENT_REMINDER'),
      preference: 'UNKNOWN',
      purposesRequiringConsent: POLICY,
    });
    expect(decision.allowed).toBe(true);
  });

  it('a service-due campaign IS optional outreach and is blocked without consent', () => {
    const decision = decideConsent({
      purpose: purposeForReason('SERVICE_DUE'),
      preference: 'UNKNOWN',
      purposesRequiringConsent: POLICY,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.requiresConsent).toBe(true);
    expect(decision.blockedReason).toMatch(/no recorded preference/i);
  });

  it('the same campaign goes to a customer who HAS opted in', () => {
    expect(
      decideConsent({ purpose: 'MARKETING', preference: 'ALLOWED', purposesRequiringConsent: POLICY }).allowed,
    ).toBe(true);
  });

  it('the factory policy gates marketing and nothing else', () => {
    expect(POLICY).toEqual(['MARKETING']);
  });
});

describe('the policy is configuration, not a constant', () => {
  it('a business can require consent for reminders too', () => {
    const policy = parsePurposePolicy(['MARKETING', 'REMINDER']);
    expect(
      decideConsent({ purpose: 'REMINDER', preference: 'UNKNOWN', purposesRequiringConsent: policy }).allowed,
    ).toBe(false);
    // …and operational messages still are not gated.
    expect(
      decideConsent({ purpose: 'TRANSACTIONAL', preference: 'UNKNOWN', purposesRequiringConsent: policy }).allowed,
    ).toBe(true);
  });

  it('a missing, empty or nonsense setting falls back to the factory policy — never to "email everyone"', () => {
    for (const bad of [undefined, null, [], {}, 'MARKETING', ['NOT_A_PURPOSE'], [42]]) {
      expect(parsePurposePolicy(bad), JSON.stringify(bad)).toEqual(['MARKETING']);
    }
  });

  it('reads a valid setting case-insensitively and de-duplicates it', () => {
    expect(parsePurposePolicy([' marketing ', 'MARKETING', 'reminder'])).toEqual(['MARKETING', 'REMINDER']);
  });
});

describe('every message has a purpose', () => {
  it('every reason is classified', () => {
    for (const reason of Object.keys(REASON_PURPOSE)) {
      expect(REASON_PURPOSE[reason as keyof typeof REASON_PURPOSE], reason).toBeTruthy();
    }
  });

  it('every seeded template carries the same purpose as its reason', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(t.purpose, t.key).toBe(purposeForReason(t.reason as never));
    }
  });

  it('the legacy code-rendered keys are classified too', () => {
    expect(purposeForTemplateKey('appointment_reminder_24h')).toBe('REMINDER');
    expect(purposeForTemplateKey('pickup_ready')).toBe('TRANSACTIONAL');
    expect(purposeForTemplateKey('maintenance_oil_change_reminder')).toBe('MARKETING');
    expect(purposeForTemplateKey('midday_followup')).toBe('MARKETING');
  });

  it('an unknown key is treated as operational, not as outreach', () => {
    // Safe direction: a message the system cannot classify is about a customer's
    // job, not a campaign — the alternative would silently block real work.
    expect(purposeForTemplateKey('something_new')).toBe('TRANSACTIONAL');
    expect(purposeForReason(null)).toBe('TRANSACTIONAL');
  });
});
