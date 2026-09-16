/**
 * CR-2026-105c — ONE reader for the `operating_hours` business rule.
 *
 * The rule's shape (site-local wall-clock times per weekday; a missing weekday
 * means closed) has two divergent readers in the codebase — the appointment
 * path validates only the start instant and skips when the rule is absent, the
 * schedule page falls back to 08:00–17:00. The public availability engine needs
 * actual instants for a day (open/close as UTC), so the conversion lives here,
 * pure and tested, and the loader resolves the site row over the global one.
 */

import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export interface OperatingHoursConfig {
  timezone?: string;
  schedule: Record<string, { open: string; close: string } | undefined>;
}

export interface DayWindow {
  /** UTC instant the site opens on that local day. */
  open: Date;
  /** UTC instant the site closes on that local day. */
  close: Date;
}

/** `YYYY-MM-DD` of an instant in the site's zone. */
export function localDayKey(instant: Date, timeZone: string): string {
  const z = toZonedTime(instant, timeZone);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
}

/** Add whole days to a `YYYY-MM-DD` key (calendar arithmetic, zone-agnostic). */
export function addDaysToKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** JS weekday (0 = Sunday) of a calendar date key. */
export function weekdayOfKey(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

/**
 * Pure: the open/close instants for one local calendar day, or `null` when the
 * site is closed that weekday (no schedule entry) or the entry is malformed.
 */
export function dayWindow(cfg: OperatingHoursConfig | null | undefined, dayKey: string, timeZone: string): DayWindow | null {
  if (!cfg?.schedule) return null;
  const entry = cfg.schedule[String(weekdayOfKey(dayKey))];
  if (!entry || !HHMM.test(entry.open) || !HHMM.test(entry.close)) return null;
  const open = fromZonedTime(`${dayKey}T${pad(entry.open)}:00`, timeZone);
  const close = fromZonedTime(`${dayKey}T${pad(entry.close)}:00`, timeZone);
  if (Number.isNaN(open.getTime()) || Number.isNaN(close.getTime()) || close <= open) return null;
  return { open, close };
}

/**
 * CR-2026-106 — the instant of a site-local wall-clock time ("15:00") on a calendar
 * day, or null when the time is malformed. Used for the latest-start cutoff.
 */
export function dayInstant(dayKey: string, hhmm: string, timeZone: string): Date | null {
  if (!HHMM.test(hhmm)) return null;
  const d = fromZonedTime(`${dayKey}T${pad(hhmm)}:00`, timeZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

/** Pure: is the whole [start, end) window inside that day's operating hours? */
export function isWindowWithinOperatingHours(
  start: Date,
  end: Date,
  cfg: OperatingHoursConfig | null | undefined,
  timeZone: string,
): boolean {
  const w = dayWindow(cfg, localDayKey(start, timeZone), timeZone);
  if (!w) return false;
  return start >= w.open && end <= w.close;
}

/**
 * Loader: the current `operating_hours` row for the site, or the global one.
 * Returns `null` when no rule exists — callers decide whether that means closed
 * (public booking: closed) or unvalidated (legacy staff path).
 */
export async function loadOperatingHours(
  prisma: {
    businessRuleConfig: {
      findFirst: (args: unknown) => Promise<{ valueJson: unknown } | null>;
    };
  },
  siteId: string,
): Promise<OperatingHoursConfig | null> {
  const now = new Date();
  const row = await prisma.businessRuleConfig.findFirst({
    where: {
      ruleKey: 'operating_hours',
      effectiveFrom: { lte: now },
      AND: [
        { OR: [{ siteId }, { siteId: null }] },
        { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
      ],
    },
    orderBy: { siteId: 'desc' },
  });
  const v = row?.valueJson as OperatingHoursConfig | undefined;
  return v && typeof v === 'object' && v.schedule && typeof v.schedule === 'object' ? v : null;
}
