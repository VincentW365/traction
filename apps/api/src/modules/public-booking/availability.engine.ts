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

/** Pure: every candidate slot of one day with its availability. */
export function computeDayAvailability(now: Date, day: DayInput, existing: ExistingBooking[], rules: SlotRules): DayAvailability {
  const closed = !day.window || day.isClosedDate || (day.isToday && !rules.sameDayAllowed);
  if (closed || !day.window) return { date: day.dateKey, closed: true, slots: [], availableCount: 0 };

  const earliest = now.getTime() + rules.minNoticeMinutes * MS;
  const step = Math.max(5, rules.slotIntervalMinutes) * MS;
  const duration = rules.durationMinutes * MS;
  const slots: Slot[] = [];
  for (let t = day.window.open.getTime(); t + duration <= day.window.close.getTime(); t += step) {
    if (t < earliest) continue;
    if (day.latestStart && t > day.latestStart.getTime()) break;
    const start = new Date(t);
    slots.push({
      startAt: start.toISOString(),
      endAt: new Date(t + duration).toISOString(),
      available: isSlotAvailable(existing, start, rules),
    });
  }
  return { date: day.dateKey, closed: false, slots, availableCount: slots.filter((s) => s.available).length };
}

/** Pure: the whole window, with the first available slot called out. */
export function computeAvailability(now: Date, days: DayInput[], existing: ExistingBooking[], rules: SlotRules): AvailabilityResult {
  const out = days.map((d) => computeDayAvailability(now, d, existing, rules));
  let nextAvailable: Slot | null = null;
  for (const d of out) {
    const s = d.slots.find((x) => x.available);
    if (s) {
      nextAvailable = s;
      break;
    }
  }
  return { nextAvailable, days: out };
}
