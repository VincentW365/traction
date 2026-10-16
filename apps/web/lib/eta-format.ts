/**
 * CR-2026-105b — one way to show an estimate everywhere.
 *
 * The API publishes ONE estimate per visit (see api `common/helpers/eta-presentation.ts`);
 * these helpers are the only place the web turns it into words, so the lobby screen,
 * the queue board, dispatch, the Visit Record and the technician workspace never
 * disagree on wording, rounding or colour.
 */

export interface EtaWindow {
  at: string;
  min: string;
  max: string;
}

export type EtaConfidence = 'ON_TRACK' | 'AT_RISK' | 'DELAYED';
export type EtaPublicState = 'ON_TIME' | 'DELAYED';

/** Staff-side shape (`eta` on board rows, dispatch jobs, visit records, technician reads). */
export interface EtaView {
  estimatedStart: EtaWindow | null;
  estimatedCompletion: EtaWindow | null;
  confidence: EtaConfidence | null;
  publicState: EtaPublicState | null;
  showRange: boolean;
  lastUpdatedAt: string | null;
  terminal: boolean;
}

/** Customer-facing shape (lobby display, status page) — no confidence reasons. */
export interface PublicEta {
  estimatedStart: EtaWindow | null;
  estimatedCompletion: EtaWindow | null;
  publicState: EtaPublicState | null;
  showRange: boolean;
}

export const CONFIDENCE_LABEL: Record<EtaConfidence, string> = {
  ON_TRACK: 'On Track',
  AT_RISK: 'At Risk',
  DELAYED: 'Delayed',
};

export const CONFIDENCE_CLASS: Record<EtaConfidence, string> = {
  ON_TRACK: 'bg-emerald-50 text-emerald-700',
  AT_RISK: 'bg-amber-50 text-amber-700',
  DELAYED: 'bg-rose-50 text-rose-700',
};

/** "3:20 PM" — in the site's zone when given, else the device zone. */
export function fmtEtaTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  try {
    return d.toLocaleTimeString([], timeZone ? { ...opts, timeZone } : opts);
  } catch {
    return d.toLocaleTimeString([], opts);
  }
}

/** "3:20 PM" or "3:15–3:30 PM" (only when the estimate is uncertain enough to show a range). */
export function fmtEtaWindow(w: EtaWindow | null | undefined, showRange: boolean, timeZone?: string): string {
  if (!w) return '—';
  if (!showRange || w.min === w.max) return fmtEtaTime(w.at, timeZone);
  const from = fmtEtaTime(w.min, timeZone);
  const to = fmtEtaTime(w.max, timeZone);
  // CR-2026-124 — the day period is said once when both ends share it:
  // "10:30–10:50 AM", as this comment always promised, rather than
  // "10:30 AM–10:50 AM", which was long enough to push a licence plate onto a
  // second line on the lobby screen. Across noon both stay: "11:50 AM–12:10 PM".
  const PERIOD = /\s?([AP]M)$/i;
  const pf = from.match(PERIOD)?.[1]?.toUpperCase();
  const pt = to.match(PERIOD)?.[1]?.toUpperCase();
  if (pf && pf === pt) return `${from.replace(PERIOD, '')}–${to}`;
  return `${from}–${to}`;
}

/** "updated 2:02 PM" for the advisor / visit record. */
export function fmtEtaUpdated(iso: string | null | undefined): string {
  if (!iso) return '';
  return `updated ${fmtEtaTime(iso)}`;
}
