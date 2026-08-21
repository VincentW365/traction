/**
 * CR-2026-033 — SMS body rendering for the Twilio provider.
 *
 * NotificationsService passes (templateKey, templateData) to the provider, so the
 * provider must render a body. Pure + unit-testable; uses only non-sensitive
 * fields already supplied by the service. Falls back to templateData.message
 * (some flows pre-render it) then a generic line for unknown keys.
 */
type Data = Record<string, unknown>;

const SITE_DEFAULT = "Bert's Auto Parts Service Centre";

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function fmtWhen(v: unknown): string {
  if (typeof v === 'string' || v instanceof Date) {
    const d = new Date(v as string | Date);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    }
  }
  return 'your scheduled time';
}

function vehicleDesc(d: Data): string {
  return (
    str(d.vehicleDescription) ||
    [d.vehicleMake, d.vehicleModel].filter(Boolean).join(' ') ||
    str(d.vehiclePlate) ||
    'your vehicle'
  );
}

export function renderSmsBody(templateKey: string, data: Data = {}): string {
  const site = str(data.siteName) || SITE_DEFAULT;
  switch (templateKey) {
    case 'appointment_confirmation':
      return `Your appointment at ${site} is confirmed for ${fmtWhen(data.scheduledStartAt)}.`;
    case 'appointment_reminder_24h':
      return `Reminder: your appointment at ${site} is tomorrow, ${fmtWhen(data.scheduledStartAt)}.`;
    case 'appointment_reminder_2h':
      return `Reminder: your appointment at ${site} is in about 2 hours (${fmtWhen(data.scheduledStartAt)}).`;
    case 'service_delay_alert':
      return `Update from ${site}: your service is taking a little longer. New estimated completion: ${fmtWhen(data.newEstimatedCompletion)}.`;
    case 'ready_for_pickup':
    case 'pickup_ready':
      return `Good news! ${vehicleDesc(data)} is ready for pickup at ${site}.`;
    case 'midday_followup':
      return str(data.message) || `Thank you for visiting ${site} today!`;
    // CR-2026-086 — due-for-service reminder. The reminder service pre-renders a
    // confidence-tiered `message` (it knows whether the due point came from a
    // confirmed interval or a mileage estimate), so that wording wins when present.
    // Previously this key had no case at all and only worked by falling through to
    // `default`, which meant one missing field would have sent "Update from Bert's."
    case 'maintenance_oil_change_reminder':
      return (
        str(data.message) ||
        `Reminder from ${site}: ${vehicleDesc(data)} is due for its next service. ` +
          `Call us to book a time that suits you.`
      );
    default:
      return str(data.message) || `Update from ${site}.`;
  }
}
