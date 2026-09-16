import { describe, it, expect, vi } from 'vitest';
import { BookingAvailabilityService, formatLatestStartLabel } from '../booking-availability.service';
import { ETA_DEFAULTS } from '../../eta/eta.config';

/**
 * CR-2026-106 — ONE availability/placement engine for customers and staff (docs/121 §D
 * "Engine parity"). The audience changes the RULES applied, never the arithmetic:
 * the same day, the same bookings, the same capacity → the same free positions.
 */

const SITE = { id: 'site-1', timezone: 'America/Jamaica' };
const HOURS = { schedule: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '08:00', close: '17:00' }])) };
const MIN = 60_000;

function build(opts: { rules?: Array<{ ruleKey: string; valueJson: unknown; siteId?: string | null }>; existing?: Array<{ scheduledStartAt: Date; scheduledEndAt: Date | null }>; capacity?: number } = {}) {
  const prisma: any = {
    businessRuleConfig: {
      findMany: vi.fn(async () => opts.rules ?? []),
      findFirst: vi.fn(async ({ where }: any) => (where?.ruleKey === 'operating_hours' ? { valueJson: HOURS } : null)),
    },
    appointment: { findMany: vi.fn(async () => opts.existing ?? []) },
  };
  const eta = { loadRules: vi.fn(async () => ({ ...ETA_DEFAULTS, capacity: opts.capacity ?? 2 })) };
  return { svc: new BookingAvailabilityService(prisma, eta as any), prisma };
}

/** A local-day key a few days out, plus the UTC instant of a wall-clock time on it (Jamaica = UTC−5, no DST). */
function dayKeyPlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const at = (key: string, hh: number, mm = 0) => new Date(`${key}T${String(hh + 5).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

describe('formatLatestStartLabel', () => {
  it('renders 24h wall clock as a 12h label', () => {
    expect(formatLatestStartLabel('15:00')).toBe('3:00 PM');
    expect(formatLatestStartLabel('09:30')).toBe('9:30 AM');
    expect(formatLatestStartLabel('12:00')).toBe('12:00 PM');
    expect(formatLatestStartLabel(null)).toBeNull();
    expect(formatLatestStartLabel('junk')).toBeNull();
  });
});

describe('audience rules', () => {
  it('CUSTOMER gets min notice, the latest start and closed dates; STAFF gets none of those, same capacity/duration', async () => {
    const key = dayKeyPlus(3);
    const { svc } = build({ rules: [{ ruleKey: 'booking_closed_dates', valueJson: [key], siteId: 'site-1' }] });
    const rules = await svc.loadRules('site-1');
    expect(rules.booking.customerLatestStart).toBe('15:00');

    const cust = svc.slotRules([{ baseDurationMinutes: 30 }], rules, 'CUSTOMER');
    const staff = svc.slotRules([{ baseDurationMinutes: 30 }], rules, 'STAFF');
    expect(cust.minNoticeMinutes).toBe(rules.booking.minNoticeMinutes);
    expect(staff.minNoticeMinutes).toBe(0);
    expect(staff.sameDayAllowed).toBe(true);
    // DEFAULT duration source → management's 80 for BOTH (not the 30-minute catalogue value)
    expect(cust.durationMinutes).toBe(80);
    expect(staff.durationMinutes).toBe(80);
    expect(cust.capacity).toBe(staff.capacity);

    const custDays = svc.dayInputs(SITE, rules, 'CUSTOMER', key, 1);
    const staffDays = svc.dayInputs(SITE, rules, 'STAFF', key, 1);
    expect(custDays[0].isClosedDate).toBe(true);
    expect(staffDays[0].isClosedDate).toBe(false);
    expect(custDays[0].latestStart?.toISOString()).toBe(at(key, 15).toISOString());
    expect(staffDays[0].latestStart).toBeNull();

    // With staff_latest_start_enforced the cutoff applies to staff too.
    const enforced = build({ rules: [{ ruleKey: 'staff_latest_start_enforced', valueJson: true, siteId: 'site-1' }] });
    const r2 = await enforced.svc.loadRules('site-1');
    expect(enforced.svc.dayInputs(SITE, r2, 'STAFF', key, 1)[0].latestStart?.toISOString()).toBe(at(key, 15).toISOString());
  });

  it('the same existing bookings yield the same free positions for both audiences (parity), and the customer list stops at 3 PM', async () => {
    const key = dayKeyPlus(3);
    const existing = [
      { scheduledStartAt: at(key, 9), scheduledEndAt: at(key, 10, 20) },
      { scheduledStartAt: at(key, 9), scheduledEndAt: at(key, 10, 20) }, // both positions taken 9:00–10:20
    ];
    const { svc } = build({ existing, capacity: 2 });
    const rules = await svc.loadRules('site-1');
    const services = [{ baseDurationMinutes: 30 }];
    const cust = await svc.availability(SITE, services, { from: key, days: 1, audience: 'CUSTOMER', rules });
    const staff = await svc.availability(SITE, services, { from: key, days: 1, audience: 'STAFF', rules });
    const custSlots = new Map(cust.days[0].slots.map((s) => [s.startAt, s.available]));
    // Every slot the customer sees has the SAME availability verdict for staff.
    for (const s of staff.days[0].slots) {
      if (custSlots.has(s.startAt)) expect(custSlots.get(s.startAt), s.startAt).toBe(s.available);
    }
    // 9:00 is taken for both; 10:20 is free for both.
    expect(staff.days[0].slots.find((s) => s.startAt === at(key, 9).toISOString())?.available).toBe(false);
    expect(staff.days[0].slots.find((s) => s.startAt === at(key, 10, 20).toISOString())?.available).toBe(true);
    // The customer is never offered a start after 15:00; staff (not enforced) see until close − duration.
    const lastCust = cust.days[0].slots[cust.days[0].slots.length - 1];
    expect(new Date(lastCust.startAt).getTime()).toBeLessThanOrEqual(at(key, 15).getTime());
    const lastStaff = staff.days[0].slots[staff.days[0].slots.length - 1];
    expect(new Date(lastStaff.startAt).getTime()).toBeGreaterThan(at(key, 15).getTime());
    expect(cust.latestStartLabel).toBe('3:00 PM');
    expect(staff.latestStartLabel).toBeNull();
    expect(cust.plannedMinutes).toBe(80);
    expect(staff.plannedMinutes).toBe(80);
  });

  it('assertSlotAllowed: customer after 15:00 → AFTER_LATEST_START; staff free unless enforced; enforced staff may override (reported)', async () => {
    const key = dayKeyPlus(3);
    const late = at(key, 15, 20);
    const end = new Date(late.getTime() + 80 * MIN);
    const { svc } = build();
    const rules = await svc.loadRules('site-1');
    expect(() => svc.assertSlotAllowed(late, end, SITE, rules, 'CUSTOMER')).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 'AFTER_LATEST_START' }) }));
    expect(svc.assertSlotAllowed(late, end, SITE, rules, 'STAFF')).toEqual({ latestStartOverridden: false });
    const enforced = build({ rules: [{ ruleKey: 'staff_latest_start_enforced', valueJson: true, siteId: 'site-1' }] });
    const r2 = await enforced.svc.loadRules('site-1');
    expect(() => enforced.svc.assertSlotAllowed(late, end, SITE, r2, 'STAFF')).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 'AFTER_LATEST_START' }) }));
    expect(enforced.svc.assertSlotAllowed(late, end, SITE, r2, 'STAFF', { overrideLatestStart: true })).toEqual({ latestStartOverridden: true });
    // 15:00 exactly is fine for everyone
    expect(svc.assertSlotAllowed(at(key, 15), new Date(at(key, 15).getTime() + 80 * MIN), SITE, rules, 'CUSTOMER')).toEqual({ latestStartOverridden: false });
  });

  it('slotStillAvailable under the lock reports booked/capacity for the staff message', async () => {
    const key = dayKeyPlus(2);
    const tx: any = {
      $executeRaw: vi.fn(async () => 1),
      appointment: { findMany: vi.fn(async () => [{ scheduledStartAt: at(key, 9), scheduledEndAt: at(key, 10, 20) }]) },
    };
    const { svc } = build({ capacity: 1 });
    const rules = await svc.loadRules('site-1');
    await svc.lockDay(tx, 'site-1', key);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const r = await svc.slotStillAvailable(tx, 'site-1', at(key, 9, 20), svc.slotRules([], rules, 'STAFF'));
    expect(r).toEqual({ available: false, booked: 1, capacity: 1 });
    const free = await svc.slotStillAvailable(tx, 'site-1', at(key, 10, 20), svc.slotRules([], rules, 'STAFF'));
    expect(free.available).toBe(true);
  });
});
