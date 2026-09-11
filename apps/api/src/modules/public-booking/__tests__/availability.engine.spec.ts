import { describe, it, expect } from 'vitest';
import { computeAvailability, computeDayAvailability, isSlotAvailable, maxConcurrentOverlap, type DayInput, type SlotRules } from '../availability.engine';
import { bookingRulesFromRows, BOOKING_DEFAULTS } from '../booking.config';

/**
 * CR-2026-105c — the slot/capacity engine (pure). Management's scenarios: next
 * available, fully booked day, closed day, capacity conflict, cancel returns
 * capacity, reschedule frees old / consumes new, 80-minute duration, catalogue
 * duration switch, min notice, same-day rule.
 */

const T = (iso: string) => new Date(iso);
const MIN = 60_000;
// Monday 2026-09-14, 08:00–17:00 Jamaica = 13:00Z–22:00Z
const day: DayInput = { dateKey: '2026-09-14', window: { open: T('2026-09-14T13:00:00Z'), close: T('2026-09-14T22:00:00Z') }, isClosedDate: false, isToday: false };
const now = T('2026-09-13T15:00:00Z');
const rules: SlotRules = { slotIntervalMinutes: 20, minNoticeMinutes: 120, sameDayAllowed: true, capacity: 2, durationMinutes: 80, defaultDurationMinutes: 80 };
const b = (start: string, minutes = 80) => ({ startAt: T(start), endAt: new Date(T(start).getTime() + minutes * MIN) });

describe('maxConcurrentOverlap', () => {
  it('counts the peak overlap inside the window; back-to-back does not overlap', () => {
    const existing = [b('2026-09-14T13:00:00Z'), b('2026-09-14T13:40:00Z'), b('2026-09-14T14:20:00Z')];
    expect(maxConcurrentOverlap(existing, T('2026-09-14T13:40:00Z'), T('2026-09-14T15:00:00Z'), 80)).toBe(2);
    expect(maxConcurrentOverlap(existing, T('2026-09-14T15:40:00Z'), T('2026-09-14T17:00:00Z'), 80)).toBe(0);
    // ends at 14:20 exactly, the next starts at 14:20 → not concurrent
    expect(maxConcurrentOverlap([b('2026-09-14T13:00:00Z')], T('2026-09-14T14:20:00Z'), T('2026-09-14T15:40:00Z'), 80)).toBe(0);
  });
  it('assumes the default duration for an appointment with no recorded end', () => {
    const existing = [{ startAt: T('2026-09-14T13:00:00Z'), endAt: null }];
    expect(maxConcurrentOverlap(existing, T('2026-09-14T14:00:00Z'), T('2026-09-14T14:30:00Z'), 80)).toBe(1);
    expect(maxConcurrentOverlap(existing, T('2026-09-14T14:30:00Z'), T('2026-09-14T15:00:00Z'), 80)).toBe(0);
  });
});

describe('computeDayAvailability', () => {
  it('generates 80-minute slots on the 20-minute grid from opening, the last ending by close', () => {
    const d = computeDayAvailability(now, day, [], rules);
    expect(d.closed).toBe(false);
    expect(d.slots[0]).toMatchObject({ startAt: '2026-09-14T13:00:00.000Z', endAt: '2026-09-14T14:20:00.000Z', available: true });
    expect(d.slots[1].startAt).toBe('2026-09-14T13:20:00.000Z');
    const last = d.slots[d.slots.length - 1];
    expect(last.endAt <= '2026-09-14T22:00:00.000Z').toBe(true);
    expect(new Date(last.endAt).getTime() + 20 * MIN > T('2026-09-14T22:00:00Z').getTime()).toBe(true);
    expect(d.availableCount).toBe(d.slots.length);
  });

  it('closed weekday, closed date, and same-day-off all yield no slots', () => {
    expect(computeDayAvailability(now, { ...day, window: null }, [], rules).closed).toBe(true);
    expect(computeDayAvailability(now, { ...day, isClosedDate: true }, [], rules).closed).toBe(true);
    expect(computeDayAvailability(now, { ...day, isToday: true }, [], { ...rules, sameDayAllowed: false }).closed).toBe(true);
    expect(computeDayAvailability(now, { ...day, isToday: true }, [], rules).closed).toBe(false);
  });

  it('honours minimum notice', () => {
    const late = T('2026-09-14T13:30:00Z'); // 8:30 local on the day
    const d = computeDayAvailability(late, day, [], rules);
    expect(d.slots[0].startAt).toBe('2026-09-14T15:40:00.000Z'); // first grid start ≥ 10:30 local
  });

  it('capacity conflict: two overlapping bookings fill both positions', () => {
    const existing = [b('2026-09-14T13:00:00Z'), b('2026-09-14T13:20:00Z')];
    const d = computeDayAvailability(now, day, existing, rules);
    const at = (iso: string) => d.slots.find((s) => s.startAt === iso)!.available;
    expect(at('2026-09-14T13:00:00.000Z')).toBe(false);
    expect(at('2026-09-14T14:00:00.000Z')).toBe(false); // overlaps the 13:20–14:40 booking + 13:00–14:20
    expect(at('2026-09-14T14:20:00.000Z')).toBe(true); // 13:00 booking ended; only one overlaps
    expect(at('2026-09-14T14:40:00.000Z')).toBe(true);
  });

  it('cancelling a booking returns the capacity; rescheduling frees the old and consumes the new', () => {
    const full = [b('2026-09-14T13:00:00Z'), b('2026-09-14T13:00:00Z')];
    expect(isSlotAvailable(full, T('2026-09-14T13:00:00Z'), rules)).toBe(false);
    const afterCancel = full.slice(1);
    expect(isSlotAvailable(afterCancel, T('2026-09-14T13:00:00Z'), rules)).toBe(true);
    // reschedule one of the two 13:00 bookings to 16:00
    const afterMove = [full[0], b('2026-09-14T16:00:00Z')];
    expect(isSlotAvailable(afterMove, T('2026-09-14T13:00:00Z'), rules)).toBe(true);
    expect(isSlotAvailable([...afterMove, b('2026-09-14T16:00:00Z')], T('2026-09-14T16:00:00Z'), rules)).toBe(false);
  });

  it('a catalogue duration simply changes the slot length', () => {
    const d = computeDayAvailability(now, day, [], { ...rules, durationMinutes: 30 });
    expect(d.slots[0].endAt).toBe('2026-09-14T13:30:00.000Z');
  });
});

describe('computeAvailability', () => {
  it('names the first available slot across days; a fully booked day defers to the next', () => {
    const tuesday: DayInput = { dateKey: '2026-09-15', window: { open: T('2026-09-15T13:00:00Z'), close: T('2026-09-15T22:00:00Z') }, isClosedDate: false, isToday: false };
    // Fill Monday completely with 2 bookings on every 20-minute grid start.
    const existing: Array<{ startAt: Date; endAt: Date }> = [];
    for (let t = T('2026-09-14T13:00:00Z').getTime(); t < T('2026-09-14T22:00:00Z').getTime(); t += 20 * MIN) {
      existing.push({ startAt: new Date(t), endAt: new Date(t + 80 * MIN) }, { startAt: new Date(t), endAt: new Date(t + 80 * MIN) });
    }
    const r = computeAvailability(now, [day, tuesday], existing, rules);
    expect(r.days[0].availableCount).toBe(0);
    expect(r.nextAvailable?.startAt).toBe('2026-09-15T13:00:00.000Z');
  });

  it('no slots anywhere → nextAvailable null', () => {
    expect(computeAvailability(now, [{ ...day, window: null }], [], rules).nextAvailable).toBeNull();
  });
});

describe('bookingRulesFromRows', () => {
  it('site rows win; invalid values fall back; closed dates are validated', () => {
    const r = bookingRulesFromRows([
      { ruleKey: 'booking_min_notice_minutes', valueJson: 30, siteId: null },
      { ruleKey: 'booking_min_notice_minutes', valueJson: 240, siteId: 's' },
      { ruleKey: 'booking_closed_dates', valueJson: ['2026-12-25', 'xmas'], siteId: 's' },
      { ruleKey: 'appointment_duration_source', valueJson: 'CATALOGUE', siteId: 's' },
      { ruleKey: 'booking_slot_interval_minutes', valueJson: 'twenty', siteId: 's' },
    ]);
    expect(r.minNoticeMinutes).toBe(240);
    expect(r.closedDates).toEqual(['2026-12-25']);
    expect(r.durationSource).toBe('CATALOGUE');
    expect(r.slotIntervalMinutes).toBe(BOOKING_DEFAULTS.slotIntervalMinutes);
  });
});
