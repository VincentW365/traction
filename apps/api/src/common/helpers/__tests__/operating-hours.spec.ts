import { describe, it, expect } from 'vitest';
import { addDaysToKey, dayWindow, isWindowWithinOperatingHours, localDayKey, weekdayOfKey } from '../operating-hours';

/** CR-2026-105c — the one operating-hours reader, in the site's zone. */
const TZ = 'America/Jamaica'; // UTC-5, no DST
const cfg = { schedule: { '1': { open: '08:00', close: '17:00' }, '6': { open: '8:00', close: '13:00' } } };

describe('operating-hours', () => {
  it('turns a local day + HH:mm into UTC instants', () => {
    // 2026-09-14 is a Monday
    const w = dayWindow(cfg, '2026-09-14', TZ)!;
    expect(w.open.toISOString()).toBe('2026-09-14T13:00:00.000Z');
    expect(w.close.toISOString()).toBe('2026-09-14T22:00:00.000Z');
  });

  it('a weekday with no entry is closed; malformed entries are closed', () => {
    expect(dayWindow(cfg, '2026-09-13', TZ)).toBeNull(); // Sunday
    expect(dayWindow({ schedule: { '1': { open: 'nine', close: '17:00' } } }, '2026-09-14', TZ)).toBeNull();
    expect(dayWindow(null, '2026-09-14', TZ)).toBeNull();
  });

  it('pads single-digit hours (Saturday 8:00)', () => {
    expect(dayWindow(cfg, '2026-09-12', TZ)!.open.toISOString()).toBe('2026-09-12T13:00:00.000Z');
  });

  it('checks the WHOLE window, not just the start', () => {
    const start = new Date('2026-09-14T21:30:00.000Z'); // 16:30 local
    expect(isWindowWithinOperatingHours(start, new Date(start.getTime() + 30 * 60_000), cfg, TZ)).toBe(true);
    expect(isWindowWithinOperatingHours(start, new Date(start.getTime() + 80 * 60_000), cfg, TZ)).toBe(false);
  });

  it('day keys: local day of an instant, calendar arithmetic, weekday', () => {
    expect(localDayKey(new Date('2026-09-14T03:30:00.000Z'), TZ)).toBe('2026-09-13'); // 22:30 previous evening local
    expect(addDaysToKey('2026-09-30', 1)).toBe('2026-10-01');
    expect(weekdayOfKey('2026-09-14')).toBe(1);
  });
});
