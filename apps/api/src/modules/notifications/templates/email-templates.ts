/**
 * CR-2026-106 — email subject + body rendering for the legacy template keys.
 *
 * Root cause it fixes (docs/121 §C3): the SMTP provider refuses any message
 * without a pre-rendered body, and four flows (pickup-ready, the 24-hour reminder
 * sweep, the midday follow-up, maintenance reminders) passed only a template key —
 * every one of their emails failed with "Empty email body" while the screen said
 * "Sent".
 *
 * CR-2026-108 — extracted so a CAPTURED message records exactly what a SENT one
 * would have contained.
 *
 * CR-2026-112 — this is now the FALLBACK renderer. Customer-facing wording lives
 * in `notification_templates` (manager-editable, versioned); these functions
 * render the same message for a deployment whose table has not been seeded yet,
 * so a fresh install can never send an empty email. The SMS renderer this file
 * used to borrow from was deleted with the SMS provider, so the wording each key
 * produces is stated here in full.
 *
 * Pure + unit-testable. Plain text (the transport sends `text`), no PII beyond
 * what the caller already supplies.
 */

type Data = Record<string, unknown>;

const SITE_DEFAULT = "Bert's Auto Parts Service Centre";

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function fmtWhen(v: unknown): string {
  if (typeof v === 'string' || v instanceof Date) {
    const d = new Date(v as string | Date);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }
  return 'your scheduled time';
}

/** The appointment time the caller already formatted in the site's zone, else the raw stamp. */
function apptWhen(d: Data): string {
  return str(d.when) || fmtWhen(d.scheduledStartAt);
}

function vehicleDesc(d: Data): string {
  return str(d.vehicleDescription) || [d.vehicleMake, d.vehicleModel].filter(Boolean).join(' ') || str(d.vehiclePlate) || 'your vehicle';
}

function greeting(d: Data): string {
  const first = str(d.customerFirstName) || str(d.customerName).split(' ')[0];
  return first ? `Hi ${first},` : 'Hello,';
}

/** "Ref BK-4821." — omitted entirely when there is no reference to quote. */
function refSuffix(d: Data): string {
  return str(d.reference) ? ` Ref ${str(d.reference)}.` : '';
}

export interface EmailContent {
  subject: string;
  body: string;
}

export function renderEmailContent(templateKey: string, data: Data = {}): EmailContent {
  const site = str(data.siteName) || SITE_DEFAULT;
  const sign = `\n\n${site}`;
  switch (templateKey) {
    case 'appointment_confirmation':
      return {
        subject: `Appointment confirmed${str(data.reference) ? ` — ${str(data.reference)}` : ''}`,
        body:
          `${greeting(data)}\n\nYour appointment at ${site} is confirmed for ${apptWhen(data)}.${refSuffix(data)}` +
          (str(data.manageUrl) ? `\n\nView, move or cancel: ${str(data.manageUrl)}` : '') +
          sign,
      };
    case 'appointment_rescheduled':
      return {
        subject: `Appointment moved${str(data.reference) ? ` — ${str(data.reference)}` : ''}`,
        body:
          `${greeting(data)}\n\nYour appointment at ${site} has been moved to ${apptWhen(data)}.${refSuffix(data)}` +
          (str(data.manageUrl) ? `\n\nView, move or cancel: ${str(data.manageUrl)}` : '') +
          sign,
      };
    case 'appointment_cancelled':
      return {
        subject: `Appointment cancelled${str(data.reference) ? ` — ${str(data.reference)}` : ''}`,
        body:
          `${greeting(data)}\n\nYour appointment at ${site} for ${apptWhen(data)}` +
          (str(data.reference) ? ` (ref ${str(data.reference)})` : '') +
          ` has been cancelled. You can book again at any time.` +
          sign,
      };
    case 'appointment_reminder_24h':
      return {
        subject: `Reminder: your appointment tomorrow at ${site}`,
        body: `${greeting(data)}\n\nThis is a reminder that your appointment at ${site} is tomorrow, ${fmtWhen(data.scheduledStartAt)}.` +
          (Array.isArray(data.services) && data.services.length ? `\nService: ${(data.services as unknown[]).map(String).join(', ')}` : '') +
          `\n\nIf you need to change it, please contact us.${sign}`,
      };
    case 'appointment_reminder_2h':
      return {
        subject: `Reminder: your appointment in about 2 hours`,
        body: `${greeting(data)}\n\nYour appointment at ${site} is in about 2 hours (${fmtWhen(data.scheduledStartAt)}).${sign}`,
      };
    case 'service_delay_alert':
      return {
        subject: `Update on your vehicle at ${site}`,
        body: `${greeting(data)}\n\nYour service is taking a little longer than planned. New estimated completion: ${fmtWhen(data.newEstimatedCompletion)}.${sign}`,
      };
    case 'ready_for_pickup':
    case 'pickup_ready':
      return {
        subject: `${vehicleDesc(data)} is ready for collection`,
        body: `${greeting(data)}\n\nGood news — ${vehicleDesc(data)} is ready for collection at ${site}.` +
          (str(data.pickupDetails) ? `\n\n${str(data.pickupDetails)}` : '') +
          sign,
      };
    case 'midday_followup':
      return {
        subject: `Thank you from ${site}`,
        body: `${greeting(data)}\n\n${str(data.message) || `Thank you for visiting ${site} today!`}${sign}`,
      };
    case 'maintenance_oil_change_reminder':
      return {
        subject: `${vehicleDesc(data)} is due for service`,
        body: `${greeting(data)}\n\n${str(data.message) || `${vehicleDesc(data)} is due for its next service. Call us to book a time that suits you.`}${sign}`,
      };
    case 'smtp_verification':
      return {
        subject: `BSOP email verification ${str(data.stamp)}`,
        body: `This is a test message from the Service Centre platform (${site}).\n\nIf you can read this, outbound email is working.\n\nSent ${str(data.stamp)}.`,
      };
    default:
      return {
        subject: `Message from ${site}`,
        body: `${greeting(data)}\n\n${str(data.message) || `Update from ${site}.`}${sign}`,
      };
  }
}
