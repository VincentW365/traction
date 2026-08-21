/**
 * CR-2026-088 — the KPI clock.
 *
 * What this measures, and deliberately does not:
 *
 *   KPI time = first "Start Work"  ->  first "Submit to QC"   (technician-controlled)
 *              minus approved excluded minutes
 *
 * It does NOT start at the appointment time, the customer's arrival, check-in,
 * queue entry, reception or pre-inspection. Those are real and they matter, but
 * they are the shop's problem, not the technician's, and folding them in would rate
 * a technician on how busy the front desk was. They stay in total visit-cycle
 * reporting, which is a separate question.
 *
 * It ends at the FIRST submission to QC. If the job later fails QC and comes back,
 * that rework is timed separately and the original completion result is preserved —
 * otherwise a technician could quietly improve a bad number by reworking, and a
 * failed job would look like a slow one rather than a quality problem.
 *
 * Everything is integer minutes with one rounding rule: round UP, once, at the end.
 * Rounding each segment would let a job accumulate a minute per pause.
 *
 * Pure functions — no database, no clock, no side effects. `now` is always passed in.
 */

import {
  rateAbsoluteCompletion,
  rateAdjustedVariance,
  isOnTarget,
  type KpiRating,
  type AbsoluteBands,
  type AdjustedTolerances,
  DEFAULT_ABSOLUTE_BANDS,
  DEFAULT_ADJUSTED_TOLERANCES,
} from './kpi-rating';

const MS_PER_MINUTE = 60_000;

/** A closed or still-open span of time. */
export interface TimeSpan {
  startedAt: Date;
  endedAt: Date | null;
}

/** A delay that has been through the approval flow. */
export interface DelaySpan extends TimeSpan {
  /** Only APPROVED delays are deducted. Requested-but-unapproved time stays in. */
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedForExclusion: boolean;
}

export interface KpiCalculationInput {
  firstWorkStartedAt: Date | null;
  firstSubmittedToQcAt: Date | null;
  /** All delay events recorded against the job. */
  delays?: DelaySpan[];
  /** The benchmark for this vehicle class + package, from the policy snapshot. */
  standardMinutes: number | null;
  absoluteBands?: AbsoluteBands;
  adjustedTolerances?: AdjustedTolerances;
  /** For an in-flight job, the moment to measure to. Omit for a finished job. */
  now?: Date;
}

export interface KpiCalculationResult {
  rawElapsedMinutes: number | null;
  approvedExcludedMinutes: number;
  kpiCompletionMinutes: number | null;
  varianceMinutes: number | null;
  /** Positive when over the standard, else 0. Mirrors `minutesUnderStandard`. */
  minutesOverStandard: number | null;
  minutesUnderStandard: number | null;
  /** Variance as a percentage of the standard, one decimal place. */
  variancePercent: number | null;
  absoluteCompletionRating: KpiRating | null;
  adjustedTechnicianRating: KpiRating | null;
  onTarget: boolean;
  /** True while the job is still running (measured to `now`, not to QC). */
  inFlight: boolean;
}

/**
 * Total minutes across a set of spans, ignoring overlap.
 *
 * Overlapping delays would otherwise be double-deducted — two technicians each
 * logging "waiting for parts" over the same twenty minutes must not remove forty.
 * Spans are merged before summing, so the result is wall-clock time delayed, which
 * is the only figure that can honestly be subtracted from a wall-clock elapsed.
 */
export function mergedSpanMinutes(spans: TimeSpan[], boundEnd?: Date): number {
  const usable = spans
    .map((s) => ({
      start: s.startedAt.getTime(),
      end: (s.endedAt ?? boundEnd ?? null)?.getTime() ?? null,
    }))
    .filter((s): s is { start: number; end: number } => s.end != null && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  if (usable.length === 0) return 0;

  let total = 0;
  let { start: curStart, end: curEnd } = usable[0];

  for (let i = 1; i < usable.length; i++) {
    const s = usable[i];
    if (s.start <= curEnd) {
      // Overlaps or touches the run in progress — extend it rather than add it.
      curEnd = Math.max(curEnd, s.end);
    } else {
      total += curEnd - curStart;
      curStart = s.start;
      curEnd = s.end;
    }
  }
  total += curEnd - curStart;

  return total / MS_PER_MINUTE;
}

/**
 * Compute the full KPI result for a job.
 *
 * Returns nulls rather than zeros when the job has not started — an unstarted job
 * has no performance, and zero would rate as Excellent.
 */
export function calculateKpi(input: KpiCalculationInput): KpiCalculationResult {
  const {
    firstWorkStartedAt,
    firstSubmittedToQcAt,
    delays = [],
    standardMinutes,
    absoluteBands = DEFAULT_ABSOLUTE_BANDS,
    adjustedTolerances = DEFAULT_ADJUSTED_TOLERANCES,
    now,
  } = input;

  const empty: KpiCalculationResult = {
    rawElapsedMinutes: null,
    approvedExcludedMinutes: 0,
    kpiCompletionMinutes: null,
    varianceMinutes: null,
    minutesOverStandard: null,
    minutesUnderStandard: null,
    variancePercent: null,
    absoluteCompletionRating: null,
    adjustedTechnicianRating: null,
    onTarget: false,
    inFlight: false,
  };

  if (!firstWorkStartedAt) return empty;

  const endAt = firstSubmittedToQcAt ?? now ?? null;
  if (!endAt) return empty;

  const rawMs = endAt.getTime() - firstWorkStartedAt.getTime();
  // A negative span means the data is wrong (clock skew, a bad backfill). Refuse to
  // rate it rather than reporting a flattering negative time.
  if (rawMs < 0) return empty;

  const inFlight = firstSubmittedToQcAt == null;

  // Only APPROVED delays that were actually requested for exclusion come out.
  // A technician can record a delay; a technician cannot approve their own.
  const excludable = delays.filter(
    (d) => d.requestedForExclusion && d.approvalStatus === 'APPROVED',
  );
  const excludedRaw = mergedSpanMinutes(excludable, endAt);

  const rawElapsedMinutes = Math.ceil(rawMs / MS_PER_MINUTE);
  // Exclusions can never exceed the elapsed time they sit inside.
  const approvedExcludedMinutes = Math.min(
    Math.ceil(excludedRaw),
    rawElapsedMinutes,
  );
  const kpiCompletionMinutes = Math.max(0, rawElapsedMinutes - approvedExcludedMinutes);

  const absoluteCompletionRating = rateAbsoluteCompletion(
    kpiCompletionMinutes,
    absoluteBands,
  );

  // Without a benchmark there is no variance and no adjusted rating. A custom,
  // unbenchmarked job is reported as such rather than being rated against a
  // standard nobody agreed to.
  if (standardMinutes == null || standardMinutes <= 0) {
    return {
      rawElapsedMinutes,
      approvedExcludedMinutes,
      kpiCompletionMinutes,
      varianceMinutes: null,
      minutesOverStandard: null,
      minutesUnderStandard: null,
      variancePercent: null,
      absoluteCompletionRating,
      adjustedTechnicianRating: null,
      onTarget: false,
      inFlight,
    };
  }

  const varianceMinutes = kpiCompletionMinutes - standardMinutes;
  const adjustedTechnicianRating = rateAdjustedVariance(varianceMinutes, adjustedTolerances);

  return {
    rawElapsedMinutes,
    approvedExcludedMinutes,
    kpiCompletionMinutes,
    varianceMinutes,
    minutesOverStandard: Math.max(0, varianceMinutes),
    minutesUnderStandard: Math.max(0, -varianceMinutes),
    variancePercent: Math.round((varianceMinutes / standardMinutes) * 1000) / 10,
    absoluteCompletionRating,
    adjustedTechnicianRating,
    onTarget: isOnTarget(adjustedTechnicianRating),
    inFlight,
  };
}

/**
 * Do any two spans in this set overlap?
 *
 * Used to refuse a delay that would double-count time already excluded, and to
 * refuse a second active work segment for the same job.
 */
export function hasOverlap(spans: TimeSpan[], boundEnd?: Date): boolean {
  const usable = spans
    .map((s) => ({
      start: s.startedAt.getTime(),
      end: (s.endedAt ?? boundEnd ?? null)?.getTime() ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < usable.length; i++) {
    if (usable[i].start < usable[i - 1].end) return true;
  }
  return false;
}
