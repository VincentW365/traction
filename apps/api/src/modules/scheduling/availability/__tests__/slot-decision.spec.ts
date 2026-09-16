import { describe, it, expect } from 'vitest';
import {
  computeAvailabilityDecision,
  computeDayDecision,
  computeAvailability,
  type DayInput,
  type ExistingBooking,
  type SlotRules,
} from '../../../public-booking/availability.engine';
import {
  toCustomerAvailability,
  isCustomerVisible,
  OPERATIONAL_REASON_CODES,
  type SlotDecision,
} from '../slot-decision';

/**
 * CR-2026-108 Stage 2 — every candidate slot must carry the reason it was or was
 * not offered, AND none of that reasoning may reach a customer.
 *
 * The defect being closed: slots rejected on timing were never returned at all
 * (a `continue` for minimum notice, a `break` past the cutoff), so "why was
 * nothing offered on Tuesday?" had no answer anywhere in the system. The risk
 * being guarded: the answer is operational — capacity numbers, rule values,
 * later staffing and resources — and must never be published.
 */

// A Tuesday: 08:00–17:00 local, expressed in UTC for America/Jamaica (UTC-5).
const OPEN = new Date('2026-09-15T13:00:00Z');
const CLOSE = new Date('2026-09-15T22:00:00Z');

function day(over: Partial<DayInput> = {}): DayInput {
  return { dateKey: '2026-09-15', window: { open: OPEN, close: CLOSE }, isClosedDate: false, isToday: false, ...over };
}
function rules(over: Partial<SlotRules> = {}): SlotRules {
  return { slotIntervalMinutes: 60, minNoticeMinutes: 0, sameDayAllowed: true, capacity: 1, durationMinutes: 60, defaultDurationMinutes: 60, ...over };
}
const NOW = new Date('2026-09-14T12:00:00Z'); // the day before — nothing is "past"
const codes = (slots: SlotDecision[]) => slots.map((s) => s.reasonCode);

describe('CR-2026-108 §2 — slot decisions carry their reason', () => {
  it('an offered slot says AVAILABLE and shows the capacity it would consume', () => {
    const d = computeDayDecision(NOW, day(), [], rules());
    const first = d.slots[0];
    expect(first.available).toBe(true);
    expect(first.reasonCode).toBe('AVAILABLE');
    expect(first.capacity).toEqual({ before: 0, after: 1, limit: 1 });
    expect(first.plannedMinutes).toBe(60);
  });

  it('a capacity-blocked slot names the rule that blocked it', () => {
    const existing: ExistingBooking[] = [{ startAt: OPEN, endAt: new Date(OPEN.getTime() + 60 * 60_000) }];
    const d = computeDayDecision(NOW, day(), existing, rules({ capacity: 1 }));
    const blocked = d.slots[0];
    expect(blocked.available).toBe(false);
    expect(blocked.reasonCode).toBe('FIXED_CAPACITY_REACHED');
    expect(blocked.capacity).toEqual({ before: 1, after: 2, limit: 1 });
    expect(blocked.rule).toContain('booking_max_concurrent_appointments=1');
  });

  /** The headline fix: these used to vanish rather than be explained. */
  it('slots inside the minimum notice are REPORTED, not dropped', () => {
    const now = new Date('2026-09-15T13:00:00Z'); // at opening
    const d = computeDayDecision(now, day({ isToday: true }), [], rules({ minNoticeMinutes: 120 }));
    expect(codes(d.slots).slice(0, 2)).toEqual(['MINIMUM_NOTICE', 'MINIMUM_NOTICE']);
    expect(d.slots[0].rule).toContain('booking_min_notice_minutes=120');
    expect(d.slots.some((s) => s.available)).toBe(true); // later ones still open
  });

  it('slots after the customer cutoff are REPORTED, not silently truncated', () => {
    const latestStart = new Date('2026-09-15T20:00:00Z'); // 15:00 local
    const d = computeDayDecision(NOW, day({ latestStart }), [], rules());
    const late = d.slots.filter((s) => s.reasonCode === 'CUSTOMER_LATEST_START');
    expect(late.length).toBeGreaterThan(0);
    expect(late[0].rule).toContain('customer_booking_latest_start');
  });

  it('a job that would not finish before close says so', () => {
    const d = computeDayDecision(NOW, day(), [], rules({ durationMinutes: 180, slotIntervalMinutes: 60 }));
    expect(codes(d.slots)).toContain('OUTSIDE_OPENING_HOURS');
  });

  it('PAST is distinguished from MINIMUM_NOTICE — a policy is not a fact', () => {
    const now = new Date('2026-09-15T16:00:00Z'); // mid-morning local
    const staff = computeDayDecision(now, day({ isToday: true }), [], rules({ minNoticeMinutes: 0 }));
    expect(codes(staff.slots)).toContain('PAST');
    expect(codes(staff.slots)).not.toContain('MINIMUM_NOTICE');
  });

  it('the three ways a day can be shut are reported separately', () => {
    expect(computeDayDecision(NOW, day({ window: null }), [], rules()).reasonCode).toBe('CLOSED_WEEKDAY');
    expect(computeDayDecision(NOW, day({ isClosedDate: true }), [], rules()).reasonCode).toBe('CLOSED_DATE');
    expect(computeDayDecision(NOW, day({ isToday: true }), [], rules({ sameDayAllowed: false })).reasonCode).toBe('SAME_DAY_NOT_ALLOWED');
  });

  it('every slot has a reason — none is left unexplained', () => {
    const d = computeAvailabilityDecision(NOW, [day(), day({ dateKey: '2026-09-16' })], [], rules({ minNoticeMinutes: 120 }));
    for (const dd of d.days) for (const s of dd.slots) expect(s.reasonCode).toBeTruthy();
  });
});

describe('CR-2026-108 §2 — the customer never sees the reasoning', () => {
  const latestStart = new Date('2026-09-15T20:00:00Z');
  const existing: ExistingBooking[] = [{ startAt: OPEN, endAt: new Date(OPEN.getTime() + 60 * 60_000) }];
  const decision = computeAvailabilityDecision(NOW, [day({ latestStart })], existing, rules({ minNoticeMinutes: 120, capacity: 1 }));
  const customer = toCustomerAvailability(decision);

  it('projects times and a boolean, and nothing else', () => {
    for (const d of customer.days) {
      expect(Object.keys(d).sort()).toEqual(['availableCount', 'closed', 'date', 'slots']);
      for (const s of d.slots) expect(Object.keys(s).sort()).toEqual(['available', 'endAt', 'startAt']);
    }
  });

  it('leaks no capacity, rule or reason anywhere in the payload', () => {
    const json = JSON.stringify(customer);
    for (const code of OPERATIONAL_REASON_CODES) expect(json).not.toContain(code);
    expect(json).not.toContain('reasonCode');
    expect(json).not.toContain('capacity');
    expect(json).not.toContain('booking_max_concurrent_appointments');
    expect(json).not.toContain('booking_min_notice_minutes');
    expect(json).not.toContain('diagnostics');
  });

  /**
   * Capacity-blocked slots stay visible (greyed out) so the customer can read the
   * shape of the day; timing-excluded ones stay hidden, exactly as before this CR.
   */
  it('shows capacity-blocked times but hides ones that were never candidates', () => {
    const visible = decision.days[0].slots.filter(isCustomerVisible).map((s) => s.reasonCode);
    expect(visible).toContain('FIXED_CAPACITY_REACHED');
    expect(visible).not.toContain('MINIMUM_NOTICE');
    expect(visible).not.toContain('CUSTOMER_LATEST_START');
    expect(visible).not.toContain('OUTSIDE_OPENING_HOURS');
  });

  it('availableCount counts only genuinely offered times', () => {
    for (const d of customer.days) {
      expect(d.availableCount).toBe(d.slots.filter((s) => s.available).length);
    }
  });
});

/**
 * The public page must be byte-for-byte what it was. Stage 2 changed how the
 * answer is computed, not what /book receives.
 */
describe('CR-2026-108 §2 — /book output is unchanged', () => {
  it('computeAvailability equals the projection of the decision', () => {
    const days = [day(), day({ dateKey: '2026-09-16' }), day({ dateKey: '2026-09-17', window: null })];
    const existing: ExistingBooking[] = [{ startAt: OPEN, endAt: new Date(OPEN.getTime() + 90 * 60_000) }];
    const r = rules({ minNoticeMinutes: 120, capacity: 2, durationMinutes: 80, slotIntervalMinutes: 20 });

    const legacy = computeAvailability(NOW, days, existing, r);
    const projected = toCustomerAvailability(computeAvailabilityDecision(NOW, days, existing, r));

    expect(legacy).toEqual(projected);
  });

  it('nextAvailable is projected too, never a rich decision', () => {
    const c = toCustomerAvailability(computeAvailabilityDecision(NOW, [day()], [], rules()));
    expect(c.nextAvailable).not.toBeNull();
    expect(Object.keys(c.nextAvailable!).sort()).toEqual(['available', 'endAt', 'startAt']);
  });
});
