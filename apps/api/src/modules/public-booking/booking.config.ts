/**
 * CR-2026-105c — self-service booking rules (BusinessRuleConfig, snake_case).
 * Defaults here are what the seed writes; a manager edits them under
 * Settings → Booking & ETA. Capacity and the default duration come from the
 * ETA rules (`eta.config.ts`) — one number of service positions, shared.
 */

export const BOOKING_RULE_KEYS = [
  'booking_enabled',
  'booking_slot_interval_minutes',
  'booking_min_notice_minutes',
  'booking_advance_window_days',
  'booking_same_day_allowed',
  'booking_closed_dates',
  'booking_excluded_service_codes',
  'booking_cancel_cutoff_hours',
  'booking_reschedule_cutoff_hours',
  'booking_max_reschedules',
  'booking_manage_token_days_after',
  'booking_arrival_instructions',
  'booking_rate_limit_per_10_min',
  'staff_capacity_warning_enabled',
  'appointment_auto_missed_enabled',
  'appointment_duration_source',
  // CR-2026-106 — latest start a CUSTOMER may book (HH:mm site-local; empty = none),
  // whether staff are held to it too, and the WhatsApp/SMS text staff send with the link.
  'customer_booking_latest_start',
  'staff_latest_start_enforced',
  'booking_share_message_template',
] as const;

export interface BookingRules {
  enabled: boolean;
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  advanceWindowDays: number;
  sameDayAllowed: boolean;
  closedDates: string[];
  excludedServiceCodes: string[];
  cancelCutoffHours: number;
  rescheduleCutoffHours: number;
  maxReschedules: number;
  manageTokenDaysAfter: number;
  arrivalInstructions: string;
  rateLimitPer10Min: number;
  staffCapacityWarning: boolean;
  autoMissedEnabled: boolean;
  durationSource: 'DEFAULT' | 'CATALOGUE';
  /** CR-2026-106 — "15:00" = customers are never offered/allowed a start after 3:00 PM; null = no cutoff. */
  customerLatestStart: string | null;
  /** CR-2026-106 — when true staff bookings are held to the same latest start (explicit, audited override). */
  staffLatestStartEnforced: boolean;
  /** CR-2026-106 — message staff send with the booking link; {bookingUrl} and {siteName} are replaced. */
  shareMessageTemplate: string;
}

export const BOOKING_DEFAULTS: BookingRules = {
  enabled: true,
  slotIntervalMinutes: 20,
  minNoticeMinutes: 120,
  advanceWindowDays: 30,
  sameDayAllowed: true,
  closedDates: [],
  excludedServiceCodes: [],
  cancelCutoffHours: 2,
  rescheduleCutoffHours: 2,
  maxReschedules: 3,
  manageTokenDaysAfter: 7,
  arrivalInstructions:
    'Please arrive about 10 minutes before your appointment with your keys. Check in at the front desk and we will take it from there.',
  rateLimitPer10Min: 10,
  staffCapacityWarning: true,
  autoMissedEnabled: false,
  durationSource: 'DEFAULT',
  customerLatestStart: '15:00',
  staffLatestStartEnforced: false,
  shareMessageTemplate: 'Hi! You can book your next service at {siteName} online here: {bookingUrl} — pick your vehicle, the service you need, and a time that suits you.',
};

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function num(v: unknown, fallback: number, min = 0): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function strings(v: unknown, fallback: string[], test?: (s: string) => boolean): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return fallback;
  return test ? (v as string[]).filter(test) : (v as string[]);
}

/** Pure: fold rule rows (site wins over global) into typed booking rules. */
export function bookingRulesFromRows(rows: Array<{ ruleKey: string; valueJson: unknown; siteId?: string | null }>): BookingRules {
  const ordered = [...rows].sort((a, b) => (a.siteId ? 1 : 0) - (b.siteId ? 1 : 0));
  const r: BookingRules = { ...BOOKING_DEFAULTS, closedDates: [...BOOKING_DEFAULTS.closedDates], excludedServiceCodes: [...BOOKING_DEFAULTS.excludedServiceCodes] };
  for (const row of ordered) {
    const v = row.valueJson;
    switch (row.ruleKey) {
      case 'booking_enabled': r.enabled = bool(v, r.enabled); break;
      case 'booking_slot_interval_minutes': r.slotIntervalMinutes = num(v, r.slotIntervalMinutes, 5); break;
      case 'booking_min_notice_minutes': r.minNoticeMinutes = num(v, r.minNoticeMinutes); break;
      case 'booking_advance_window_days': r.advanceWindowDays = num(v, r.advanceWindowDays, 1); break;
      case 'booking_same_day_allowed': r.sameDayAllowed = bool(v, r.sameDayAllowed); break;
      case 'booking_closed_dates': r.closedDates = strings(v, r.closedDates, (s) => DAY_KEY.test(s)); break;
      case 'booking_excluded_service_codes': r.excludedServiceCodes = strings(v, r.excludedServiceCodes); break;
      case 'booking_cancel_cutoff_hours': r.cancelCutoffHours = num(v, r.cancelCutoffHours); break;
      case 'booking_reschedule_cutoff_hours': r.rescheduleCutoffHours = num(v, r.rescheduleCutoffHours); break;
      case 'booking_max_reschedules': r.maxReschedules = num(v, r.maxReschedules); break;
      case 'booking_manage_token_days_after': r.manageTokenDaysAfter = num(v, r.manageTokenDaysAfter, 1); break;
      case 'booking_arrival_instructions': if (typeof v === 'string' && v.trim()) r.arrivalInstructions = v; break;
      case 'booking_rate_limit_per_10_min': r.rateLimitPer10Min = num(v, r.rateLimitPer10Min, 1); break;
      case 'staff_capacity_warning_enabled': r.staffCapacityWarning = bool(v, r.staffCapacityWarning); break;
      case 'appointment_auto_missed_enabled': r.autoMissedEnabled = bool(v, r.autoMissedEnabled); break;
      case 'appointment_duration_source': if (v === 'DEFAULT' || v === 'CATALOGUE') r.durationSource = v; break;
      case 'customer_booking_latest_start':
        if (v === null || v === '' || v === false) r.customerLatestStart = null;
        else if (typeof v === 'string' && HHMM.test(v.trim())) r.customerLatestStart = v.trim().padStart(5, '0');
        break;
      case 'staff_latest_start_enforced': r.staffLatestStartEnforced = bool(v, r.staffLatestStartEnforced); break;
      case 'booking_share_message_template': if (typeof v === 'string' && v.trim()) r.shareMessageTemplate = v; break;
      default: break;
    }
  }
  return r;
}
