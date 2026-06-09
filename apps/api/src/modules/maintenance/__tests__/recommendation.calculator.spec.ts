import { describe, it, expect } from 'vitest';
import {
  calculateAdvisory,
  calculatePostService,
} from '../engine/recommendation.calculator';

/**
 * DMAIC Rule 7 — service-due = last service (date/odometer) + configured interval.
 */
describe('Rule 7: service-due calculation (calculateAdvisory)', () => {
  const base = {
    currentOdometer: 52000,
    lastServiceOdometer: 50000,
    lastServiceDate: new Date(2026, 0, 15), // 15 Jan 2026 (local)
    intervalMiles: 5000,
    intervalMonths: 6,
    drivingProfile: 'NORMAL' as const,
  };

  it('normal interval: nextDue = last service + interval (date and odometer)', () => {
    const r = calculateAdvisory(base);
    expect(r.isDeterminable).toBe(true);
    expect(r.nextDueOdometer).toBe(55000); // 50000 + 5000
    expect(r.nextDueDate?.getFullYear()).toBe(2026);
    expect(r.nextDueDate?.getMonth()).toBe(6); // Jul (0-based) = Jan + 6
    expect(r.nextDueDate?.getDate()).toBe(15);
  });

  it('missing last service entirely (no date, no odometer) → not determinable, all null', () => {
    const r = calculateAdvisory({ ...base, lastServiceOdometer: null, lastServiceDate: null });
    expect(r.isDeterminable).toBe(false);
    expect(r.nextDueOdometer).toBeNull();
    expect(r.nextDueDate).toBeNull();
    expect(r.dueNowFlag).toBe(false);
  });

  it('missing last service DATE only → odometer due computed, date due null (still determinable)', () => {
    const r = calculateAdvisory({ ...base, lastServiceDate: null });
    expect(r.isDeterminable).toBe(true);
    expect(r.nextDueOdometer).toBe(55000);
    expect(r.nextDueDate).toBeNull();
  });

  it('interval config edge: intervalMonths null → no date due; intervalMiles null → no odometer due', () => {
    expect(calculateAdvisory({ ...base, intervalMonths: null }).nextDueDate).toBeNull();
    expect(calculateAdvisory({ ...base, intervalMiles: null }).nextDueOdometer).toBe(null);
    // both intervals null but a baseline exists → determinable, both due null
    const both = calculateAdvisory({ ...base, intervalMonths: null, intervalMiles: null });
    expect(both.isDeterminable).toBe(true);
    expect(both.nextDueDate).toBeNull();
    expect(both.nextDueOdometer).toBeNull();
  });

  it('dueNowFlag true when current odometer has passed next-due', () => {
    const r = calculateAdvisory({ ...base, currentOdometer: 56000 }); // > 55000
    expect(r.dueNowFlag).toBe(true);
  });

  it('dueNowFlag true when the due DATE is already in the past', () => {
    const r = calculateAdvisory({
      ...base,
      currentOdometer: 50000, // not odometer-due
      lastServiceDate: new Date(2020, 0, 1),
      intervalMonths: 6, // due 2020-07-01, long past
    });
    expect(r.dueNowFlag).toBe(true);
  });

  it('edge: end-of-month interval rolls over per JS Date semantics (documented behavior)', () => {
    // 31 Jan + 1 month → Feb has 28 days (2026) → rolls to 3 Mar.
    const r = calculateAdvisory({
      ...base,
      lastServiceDate: new Date(2026, 0, 31),
      intervalMonths: 1,
    });
    expect(r.nextDueDate?.getMonth()).toBe(2); // March
    expect(r.nextDueDate?.getDate()).toBe(3);
  });
});

describe('Rule 7: post-service basis (calculatePostService)', () => {
  it('next due = just-serviced odometer/date + interval; dueNow always false', () => {
    const r = calculatePostService({
      currentOdometer: 60000,
      serviceDate: new Date(2026, 1, 10), // 10 Feb 2026
      intervalMiles: 5000,
      intervalMonths: 4,
      drivingProfile: 'NORMAL',
    });
    expect(r.nextDueOdometer).toBe(65000);
    expect(r.nextDueDate?.getMonth()).toBe(5); // Jun
    expect(r.nextDueDate?.getDate()).toBe(10);
    expect(r.dueNowFlag).toBe(false);
    expect(r.basisOdometer).toBe(60000);
  });

  it('null intervals → null next-due fields', () => {
    const r = calculatePostService({
      currentOdometer: 60000,
      serviceDate: new Date(2026, 1, 10),
      intervalMiles: null,
      intervalMonths: null,
      drivingProfile: 'NORMAL',
    });
    expect(r.nextDueOdometer).toBeNull();
    expect(r.nextDueDate).toBeNull();
  });
});
