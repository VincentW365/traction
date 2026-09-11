/**
 * CR-2026-105b — the ONE read-side presentation of an estimate (pure).
 *
 * Every surface — lobby display, customer status page, queue board, dispatch,
 * Visit Record, technician workspace, advisor ticket view — turns the persisted
 * `ServiceVisit.currentEtaStartAt / currentEtaCompleteAt` into what a person sees
 * through this function, so no two screens can disagree about the same car.
 *
 * Confidence and ranges are DERIVED here rather than stored: the inputs are the
 * persisted times, the visit/order statuses, the ranked position and the promised
 * or scheduled time — all already on the records the caller has loaded.
 *
 * Public callers must project only `estimatedStart`, `estimatedCompletion` and
 * `publicState`; never `confidence` reasons. No customer data enters this helper.
 */

import type { EtaPresentationConfig } from '../../modules/scheduling/eta/eta.config';

export type EtaConfidence = 'ON_TRACK' | 'AT_RISK' | 'DELAYED';
export type EtaPublicState = 'ON_TIME' | 'DELAYED';

export interface EtaWindow {
  /** Point estimate, rounded to 5 minutes (ISO). */
  at: string;
  /** Range bounds, rounded to 5 minutes (ISO). Equal to `at` when no range is shown. */
  min: string;
  max: string;
}

export interface EtaPresentation {
  estimatedStart: EtaWindow | null;
  estimatedCompletion: EtaWindow | null;
  confidence: EtaConfidence | null;
  publicState: EtaPublicState | null;
  /** True when the uncertainty is wide enough that a range should be shown instead of a single time. */
  showRange: boolean;
  lastUpdatedAt: string | null;
  /** Terminal visits (ready for pickup / closed / abandoned / cancelled) carry no estimate. */
  terminal: boolean;
}

export interface EtaPresentInput {
  now: Date;
  visitStatus: string;
  queueRank: number | null;
  /** Statuses of the visit's non-cancelled service orders (any order set). */
  orderStatuses: string[];
  promisedCompletionAt: Date | string | null;
  scheduledStartAt: Date | string | null;
  currentEtaStartAt: Date | string | null;
  currentEtaCompleteAt: Date | string | null;
  lastUpdatedAt: Date | string | null;
  config: EtaPresentationConfig;
}

const TERMINAL_VISIT = new Set(['READY_FOR_PICKUP', 'CLOSED', 'ABANDONED', 'CANCELLED']);
const HOLD_ORDER = new Set(['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER']);
const ACTIVE_ORDER = new Set(['IN_PROGRESS', 'PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER', 'QC']);
const IN_SERVICE_VISIT = new Set(['IN_SERVICE', 'QC', 'WAITING_PARTS']);
const MS = 60_000;

const EMPTY: EtaPresentation = {
  estimatedStart: null,
  estimatedCompletion: null,
  confidence: null,
  publicState: null,
  showRange: false,
  lastUpdatedAt: null,
  terminal: false,
};

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Round to the nearest 5 minutes — a lobby screen must never claim 3:22 PM. */
export function roundToFiveMinutes(d: Date): Date {
  const step = 5 * MS;
  return new Date(Math.round(d.getTime() / step) * step);
}

function window(at: Date, halfWidthMinutes: number, showRange: boolean): EtaWindow {
  const hw = showRange ? halfWidthMinutes * MS : 0;
  return {
    at: roundToFiveMinutes(at).toISOString(),
    min: roundToFiveMinutes(new Date(at.getTime() - hw)).toISOString(),
    max: roundToFiveMinutes(new Date(at.getTime() + hw)).toISOString(),
  };
}

export function presentEta(input: EtaPresentInput): EtaPresentation {
  const { now, config } = input;
  const lastUpdatedAt = toDate(input.lastUpdatedAt)?.toISOString() ?? null;

  if (TERMINAL_VISIT.has(input.visitStatus)) {
    return { ...EMPTY, terminal: true, lastUpdatedAt };
  }

  const start = toDate(input.currentEtaStartAt);
  const complete = toDate(input.currentEtaCompleteAt);
  const promised = toDate(input.promisedCompletionAt);
  const scheduled = toDate(input.scheduledStartAt);

  const onHold = input.orderStatuses.some((s) => HOLD_ORDER.has(s));
  const inService = IN_SERVICE_VISIT.has(input.visitStatus) || input.orderStatuses.some((s) => ACTIVE_ORDER.has(s));
  const inQc = input.visitStatus === 'QC' || (input.orderStatuses.length > 0 && input.orderStatuses.every((s) => s === 'QC' || !ACTIVE_ORDER.has(s)) && input.orderStatuses.some((s) => s === 'QC'));
  const blocked = !inService && input.queueRank == null;

  // Blocked or not yet projected: no times. A blocked car is honestly "delayed"
  // to the customer; the reason stays on the staff side.
  if (blocked || !complete) {
    return {
      ...EMPTY,
      confidence: blocked ? 'DELAYED' : null,
      publicState: blocked ? 'DELAYED' : null,
      lastUpdatedAt,
    };
  }

  // --- confidence -------------------------------------------------------------
  let confidence: EtaConfidence = 'ON_TRACK';
  const marginMs = config.atRiskMarginMinutes * MS;
  const graceMs = config.delayedGraceMinutes * MS;

  if (onHold) confidence = 'DELAYED';
  else if (promised && now.getTime() > promised.getTime()) confidence = 'DELAYED';
  else if (inService && now.getTime() > complete.getTime() + graceMs) confidence = 'DELAYED';
  else if (!inService && scheduled && start && start.getTime() > scheduled.getTime() + marginMs) confidence = 'DELAYED';
  else if (promised && complete.getTime() > promised.getTime() - marginMs) confidence = 'AT_RISK';
  else if (!inService && scheduled && start && start.getTime() > scheduled.getTime()) confidence = 'AT_RISK';
  else if (inService && !inQc && now.getTime() > complete.getTime() - marginMs) confidence = 'AT_RISK';

  // --- range width ------------------------------------------------------------
  const positionsAhead = !inService && input.queueRank != null ? Math.max(0, input.queueRank - 1) : 0;
  let halfWidth = inService
    ? confidence === 'ON_TRACK'
      ? 0
      : config.rangeBaseMinutes
    : Math.min(config.rangeBaseMinutes + config.rangePerPositionMinutes * positionsAhead, config.rangeMaxMinutes);
  if (positionsAhead > 0 && halfWidth >= config.rangeMaxMinutes && confidence === 'ON_TRACK') confidence = 'AT_RISK';
  const showRange = halfWidth >= config.rangePointThresholdMinutes;
  if (!showRange) halfWidth = 0;

  return {
    estimatedStart: !inService && start ? window(start, halfWidth, showRange) : null,
    estimatedCompletion: window(complete, halfWidth, showRange),
    confidence,
    publicState: confidence === 'DELAYED' ? 'DELAYED' : 'ON_TIME',
    showRange,
    lastUpdatedAt,
    terminal: false,
  };
}

/** Public-safe projection: times and state only — never the confidence reasons. */
export function toPublicEta(p: EtaPresentation): {
  estimatedStart: EtaWindow | null;
  estimatedCompletion: EtaWindow | null;
  publicState: EtaPublicState | null;
  showRange: boolean;
} {
  return {
    estimatedStart: p.estimatedStart,
    estimatedCompletion: p.estimatedCompletion,
    publicState: p.publicState,
    showRange: p.showRange,
  };
}
