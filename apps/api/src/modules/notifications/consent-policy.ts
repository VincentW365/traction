import { NotificationReason } from '@prisma/client';

/**
 * CR-2026-113 — which customer emails need recorded consent, and which do not.
 *
 * The rule this encodes is deliberately narrow: **the platform does not decide
 * what the law requires.** It makes the business purpose of every message
 * explicit, and applies the consent requirement to whichever purposes the
 * business has configured. Changing that policy is a settings change
 * (`notification_purposes_requiring_consent`), not a code change.
 *
 * Why it exists: before this CR one flag gated every message, so an advisor had
 * to override a customer's preference to send an appointment confirmation. An
 * override used on the routine path stops meaning anything — the flag erodes
 * until nobody reads it. Separating purpose from preference keeps the override
 * exceptional, which is the only state in which it is worth auditing.
 *
 * Pure and dependency-free so the policy can be unit-tested on its own.
 */

export type CommunicationPurposeName = 'TRANSACTIONAL' | 'REMINDER' | 'MARKETING';

export const COMMUNICATION_PURPOSES: CommunicationPurposeName[] = [
  'TRANSACTIONAL',
  'REMINDER',
  'MARKETING',
];

/** What each purpose means, in the words the settings screen shows a manager. */
export const PURPOSE_DESCRIPTIONS: Record<CommunicationPurposeName, string> = {
  TRANSACTIONAL:
    'Needed to manage a booking, visit or service the customer already has with us — confirmations, changes, cancellations, authorisation requests, ready for collection.',
  REMINDER: 'A prompt about a commitment the customer has already made, such as an appointment reminder.',
  MARKETING:
    'Optional outreach the customer can decline without losing anything operational — service-due campaigns, offers, non-essential follow-ups.',
};

/** The business rule that carries the policy, and its factory value. */
export const CONSENT_POLICY_RULE_KEY = 'notification_purposes_requiring_consent';
export const DEFAULT_PURPOSES_REQUIRING_CONSENT: CommunicationPurposeName[] = ['MARKETING'];

/**
 * The factory purpose for each reason. A template row's `purpose` column wins —
 * this is the starting point and the answer for a flow that has no template.
 */
export const REASON_PURPOSE: Record<NotificationReason, CommunicationPurposeName> = {
  // The customer has a live transaction with us; these messages ARE the service.
  QUEUE_CHECKED_IN: 'TRANSACTIONAL',
  QUEUE_WORK_STARTED: 'TRANSACTIONAL',
  QUEUE_UPDATE: 'TRANSACTIONAL',
  PICKUP_READY: 'TRANSACTIONAL',
  CUSTOMER_ACTION_REQUIRED: 'TRANSACTIONAL',
  APPOINTMENT_CONFIRMATION: 'TRANSACTIONAL',
  APPOINTMENT_CHANGED: 'TRANSACTIONAL',
  APPOINTMENT_CANCELLED: 'TRANSACTIONAL',
  // Staff-written, sent from a customer/vehicle/visit record while handling that
  // customer's business. Configurable per template if a site uses it otherwise.
  CUSTOM: 'TRANSACTIONAL',
  // A prompt about a commitment already made.
  APPOINTMENT_REMINDER: 'REMINDER',
  // Outreach about work the customer has not asked for yet.
  SERVICE_DUE: 'MARKETING',
};

/** The factory purpose for the legacy (code-rendered) template keys. */
export const TEMPLATE_KEY_PURPOSE: Record<string, CommunicationPurposeName> = {
  appointment_confirmation: 'TRANSACTIONAL',
  appointment_rescheduled: 'TRANSACTIONAL',
  appointment_cancelled: 'TRANSACTIONAL',
  appointment_reminder_24h: 'REMINDER',
  appointment_reminder_2h: 'REMINDER',
  service_delay_alert: 'TRANSACTIONAL',
  ready_for_pickup: 'TRANSACTIONAL',
  pickup_ready: 'TRANSACTIONAL',
  // A thank-you after the visit is pleasant, not operational: the customer can
  // decline it without losing anything.
  midday_followup: 'MARKETING',
  maintenance_oil_change_reminder: 'MARKETING',
  // A system test message to an address a manager typed. Never customer outreach.
  smtp_verification: 'TRANSACTIONAL',
};

export function purposeForReason(reason: NotificationReason | null | undefined): CommunicationPurposeName {
  return (reason && REASON_PURPOSE[reason]) || 'TRANSACTIONAL';
}

export function purposeForTemplateKey(key: string | null | undefined): CommunicationPurposeName {
  return (key && TEMPLATE_KEY_PURPOSE[key]) || 'TRANSACTIONAL';
}

/** Read the configured policy, falling back to the factory value. */
export function parsePurposePolicy(value: unknown): CommunicationPurposeName[] {
  if (!Array.isArray(value)) return [...DEFAULT_PURPOSES_REQUIRING_CONSENT];
  const valid = value
    .map((v) => String(v).trim().toUpperCase())
    .filter((v): v is CommunicationPurposeName => (COMMUNICATION_PURPOSES as string[]).includes(v));
  // An empty or unrecognisable setting is a misconfiguration, not an instruction
  // to start emailing everyone: fall back to the factory policy.
  return valid.length ? [...new Set(valid)] : [...DEFAULT_PURPOSES_REQUIRING_CONSENT];
}

export interface ConsentDecision {
  /** May this message be sent without an explicit staff override? */
  allowed: boolean;
  /** Does this purpose require recorded consent under the current policy? */
  requiresConsent: boolean;
  /** Why it is blocked, in the words staff should read. */
  blockedReason: string | null;
}

/**
 * The one consent decision. Both the staff composer and the automatic flows ask
 * this, so a message is never allowed on one path and refused on the other.
 */
export function decideConsent(input: {
  purpose: CommunicationPurposeName;
  customerOptedIn: boolean;
  purposesRequiringConsent: CommunicationPurposeName[];
}): ConsentDecision {
  const requiresConsent = input.purposesRequiringConsent.includes(input.purpose);
  if (!requiresConsent || input.customerOptedIn) {
    return { allowed: true, requiresConsent, blockedReason: null };
  }
  return {
    allowed: false,
    requiresConsent: true,
    blockedReason:
      'This customer has not opted in to optional emails, and this message is optional outreach rather than something they need to receive about a booking or a job in progress.',
  };
}

/** The shortest reason a manager may give when overriding a preference. */
export const MIN_OVERRIDE_REASON_LENGTH = 10;
