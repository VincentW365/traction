import {
  toCustomerAvailability,
  type AvailabilityDecision,
  type DayDecision,
  type SlotDecision,
} from '../scheduling/availability/slot-decision';

/**
 * CR-2026-105c — the availability engine (pure, no I/O). SCH-001 realised:
 * slots come from operating hours, closed dates, the configured number of
 * concurrent service positions, the planned duration, and the appointments
 * already on the book.
 *
 * A slot is AVAILABLE when, at no instant inside [start, start + duration), the
 * number of overlapping active appointments reaches the capacity — so two
 * appointments can never consume the same constrained position. The same test,
 * run again inside the confirming transaction under a per-site-per-day advisory
 * lock, is what makes a concurrent claim of the last slot lose cleanly.
 */

export interface SlotRules {
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  sameDayAllowed: boolean;
  /** Concurrent service positions. */
  capacity: number;
  /** Planned length of the booking being placed. */
  durationMinutes: number;
  /** Length assumed for an existing appointment with no recorded end. */
  defaultDurationMinutes: number;
}

export interface ExistingBooking {
  startAt: Date;
  endAt: Date | null;
}

export interface DayInput {
  /** Local calendar date, YYYY-MM-DD. */
  dateKey: string;
  /** Open/close instants, or null when the site is closed that weekday. */
  window: { open: Date; close: Date } | null;
  /** Listed in `booking_closed_dates`. */
  isClosedDate: boolean;
  /** Is this the site's current local day. */
  isToday: boolean;
  /**
   * CR-2026-106 — no start time AFTER this instant is offered (e.g. 15:00 local for
   * customers). Null = no cutoff. Enforced again server-side on confirm.
   */
  latestStart?: Date | null;
}

export interface Slot {
  startAt: string;
  endAt: string;
  available: boolean;
}

export interface DayAvailability {
  date: string;
  closed: boolean;
  slots: Slot[];
  availableCount: number;
}

export interface AvailabilityResult {
  nextAvailable: Slot | null;
  days: DayAvailability[];
}

const MS = 60_000;

/** Highest number of existing bookings overlapping at any instant of [start, end). */
export function maxConcurrentOverlap(existing: ExistingBooking[], start: Date, end: Date, defaultDurationMinutes: number): number {
  const events: Array<[number, number]> = [];
  for (const b of existing) {
    const s = b.startAt.getTime();
    const e = (b.endAt ?? new Date(s + defaultDurationMinutes * MS)).getTime();
    if (s < end.getTime() && e > start.getTime()) {
      events.push([Math.max(s, start.getTime()), +1]);
      events.push([Math.min(e, end.getTime()), -1]);
    }
  }
  // Ends before starts at the same instant: back-to-back bookings do not overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, delta] of events) {
    cur += delta;
    if (cur > max) max = cur;
  }
  return max;
}

export function isSlotAvailable(existing: ExistingBooking[], start: Date, rules: SlotRules): boolean {
  const end = new Date(start.getTime() + rules.durationMinutes * MS);
  return maxConcurrentOverlap(existing, start, end, rules.defaultDurationMinutes) < Math.max(1, rules.capacity);
}

/**
 * CR-2026-108 Stage 2 — pure: every candidate slot of one day WITH THE REASON.
 *
 * This is now the primary computation. Slots the previous version silently
 * dropped (before the minimum notice, after the customer cutoff, not finishing
 * before close) are produced here, marked unavailable and carrying the rule that
 * excluded them — that is the whole point, so an analyst can answer "why was
 * nothing offered on Tuesday?". `computeDayAvailability` below projects this
 * down to the shape the public page already consumed, so /book is unchanged.
 */
export function computeDayDecision(now: Date, day: DayInput, existing: ExistingBooking[], rules: SlotRules): DayDecision {
  // Day-level exclusions, in the order they are decided. Each is reported
  // separately rather than collapsing into one "closed" flag: "we are shut on
  // Sundays", "we are shut on Boxing Day" and "we do not take same-day online"
  // are three different conversations with a customer.
  if (!day.window) return closedDay(day.dateKey, 'CLOSED_WEEKDAY');
  if (day.isClosedDate) return closedDay(day.dateKey, 'CLOSED_DATE');
  if (day.isToday && !rules.sameDayAllowed) return closedDay(day.dateKey, 'SAME_DAY_NOT_ALLOWED');

  const earliest = now.getTime() + rules.minNoticeMinutes * MS;
  const step = Math.max(5, rules.slotIntervalMinutes) * MS;
  const duration = rules.durationMinutes * MS;
  const limit = Math.max(1, rules.capacity);
  const slots: SlotDecision[] = [];

  // Walk the whole grid to the close, so a slot excluded by the cutoff is still
  // reported. The loop no longer breaks early — an early `break` is exactly how
  // the reason went missing before.
  for (let t = day.window.open.getTime(); t < day.window.close.getTime(); t += step) {
    const start = new Date(t);
    const end = new Date(t + duration);
    const before = maxConcurrentOverlap(existing, start, end, rules.defaultDurationMinutes);
    const base = {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      plannedMinutes: rules.durationMinutes,
      capacity: { before, after: before + 1, limit },
    };

    if (t + duration > day.window.close.getTime()) {
      slots.push({ ...base, available: false, reasonCode: 'OUTSIDE_OPENING_HOURS', rule: `closes ${day.window.close.toISOString()}` });
      continue;
    }
    if (t < now.getTime() && rules.minNoticeMinutes === 0) {
      // Staff have no notice requirement, so "too soon" really is just "past".
      slots.push({ ...base, available: false, reasonCode: 'PAST' });
      continue;
    }
    if (t < earliest) {
      slots.push({ ...base, available: false, reasonCode: 'MINIMUM_NOTICE', rule: `booking_min_notice_minutes=${rules.minNoticeMinutes}` });
      continue;
    }
    if (day.latestStart && t > day.latestStart.getTime()) {
      slots.push({ ...base, available: false, reasonCode: 'CUSTOMER_LATEST_START', rule: `customer_booking_latest_start (${day.latestStart.toISOString()})` });
      continue;
    }
    if (before >= limit) {
      slots.push({ ...base, available: false, reasonCode: 'FIXED_CAPACITY_REACHED', rule: `booking_max_concurrent_appointments=${limit}` });
      continue;
    }
    slots.push({ ...base, available: true, reasonCode: 'AVAILABLE' });
  }

  return { date: day.dateKey, closed: false, slots, availableCount: slots.filter((s) => s.available).length };
}

function closedDay(date: string, reasonCode: DayDecision['reasonCode']): DayDecision {
  return { date, closed: true, reasonCode, slots: [], availableCount: 0 };
}

/** Pure: the whole window as internal decisions, first available called out. */
export function computeAvailabilityDecision(
  now: Date,
  days: DayInput[],
  existing: ExistingBooking[],
  rules: SlotRules,
): AvailabilityDecision {
  const out = days.map((d) => computeDayDecision(now, d, existing, rules));
  let nextAvailable: SlotDecision | null = null;
  for (const d of out) {
    const s = d.slots.find((x) => x.available);
    if (s) {
      nextAvailable = s;
      break;
    }
  }
  return { nextAvailable, days: out };
}

/**
 * Pure: every candidate slot of one day with its availability.
 *
 * Retained shape (startAt/endAt/available only) — the customer-safe projection of
 * `computeDayDecision`. Kept so existing callers and the public page are unchanged.
 */
export function computeDayAvailability(now: Date, day: DayInput, existing: ExistingBooking[], rules: SlotRules): DayAvailability {
  const decision = computeDayDecision(now, day, existing, rules);
  const [day0] = toCustomerAvailability({ nextAvailable: null, days: [decision] }).days;
  return day0;
}

/** Pure: the whole window, with the first available slot called out. */
export function computeAvailability(now: Date, days: DayInput[], existing: ExistingBooking[], rules: SlotRules): AvailabilityResult {
  return toCustomerAvailability(computeAvailabilityDecision(now, days, existing, rules));
}
