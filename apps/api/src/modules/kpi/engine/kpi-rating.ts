/**
 * CR-2026-088 — technician KPI ratings.
 *
 * Two ratings are produced for every eligible job, and NEITHER overwrites the other:
 *
 *  A. `absoluteCompletionRating` — the manager's original fixed table, applied to
 *     the actual KPI completion time regardless of what the job was:
 *
 *         <= 120 min  EXCELLENT
 *        121-150 min  MEETS_TARGET
 *        151-180 min  NEEDS_IMPROVEMENT
 *         > 180 min   BELOW_STANDARD
 *
 *  B. `adjustedTechnicianRating` — the same idea measured against the benchmark for
 *     THIS vehicle class and package, via `variance = actual - standard`:
 *
 *          <= 0 min   EXCELLENT
 *          1-30 min   MEETS_TARGET
 *         31-60 min   NEEDS_IMPROVEMENT
 *          > 60 min   BELOW_STANDARD
 *
 * Both exist because a single fixed band systematically punishes scope: an SUV
 * general service has a 120-minute standard, so on the absolute table the very best
 * possible outcome is "Excellent" only by finishing at the standard, and a sedan
 * technician doing the smallest package starts two bands ahead. The adjusted rating
 * is the fair technician-comparison metric; the absolute rating is kept so the
 * manager can still watch the raw completion bands they asked for.
 *
 * Everything is INTEGER MINUTES. No decimal-hour arithmetic anywhere — 2.5 hours as
 * a float is a rounding trap at exactly the boundary the whole table turns on.
 */

export type KpiRating =
  | 'EXCELLENT'
  | 'MEETS_TARGET'
  | 'NEEDS_IMPROVEMENT'
  | 'BELOW_STANDARD';

export const KPI_RATING_LABELS: Record<KpiRating, string> = {
  EXCELLENT: 'Excellent',
  MEETS_TARGET: 'Meets Target',
  NEEDS_IMPROVEMENT: 'Needs Improvement',
  BELOW_STANDARD: 'Below Standard',
};

/**
 * The manager's absolute completion bands, in minutes. Inclusive upper bounds.
 * Held here as the fallback; the live values come from the KpiPolicy snapshot so
 * changing them later cannot silently rewrite historical results.
 */
export const DEFAULT_ABSOLUTE_BANDS = {
  excellentMaxMinutes: 120,
  meetsTargetMaxMinutes: 150,
  needsImprovementMaxMinutes: 180,
} as const;

/** Variance tolerances for the scope-adjusted rating, in minutes. */
export const DEFAULT_ADJUSTED_TOLERANCES = {
  meetsToleranceMinutes: 30,
  needsImprovementToleranceMinutes: 60,
} as const;

export interface AbsoluteBands {
  excellentMaxMinutes: number;
  meetsTargetMaxMinutes: number;
  needsImprovementMaxMinutes: number;
}

export interface AdjustedTolerances {
  meetsToleranceMinutes: number;
  needsImprovementToleranceMinutes: number;
}

/**
 * A. The manager's fixed completion-time table.
 *
 * @param kpiCompletionMinutes whole minutes of technician-controlled work time.
 * @returns null when there is no time to rate — "no work recorded" is not a
 *          performance result and must never read as Excellent.
 */
export function rateAbsoluteCompletion(
  kpiCompletionMinutes: number | null | undefined,
  bands: AbsoluteBands = DEFAULT_ABSOLUTE_BANDS,
): KpiRating | null {
  if (!isUsableMinutes(kpiCompletionMinutes)) return null;
  const m = kpiCompletionMinutes as number;

  if (m <= bands.excellentMaxMinutes) return 'EXCELLENT';
  if (m <= bands.meetsTargetMaxMinutes) return 'MEETS_TARGET';
  if (m <= bands.needsImprovementMaxMinutes) return 'NEEDS_IMPROVEMENT';
  return 'BELOW_STANDARD';
}

/**
 * B. The scope-adjusted technician rating.
 *
 * Finishing at or inside the standard is Excellent — beating the benchmark by an
 * hour is not "more excellent", so the band is deliberately open-ended downward.
 *
 * @param varianceMinutes actual minus standard. Negative = under standard.
 */
export function rateAdjustedVariance(
  varianceMinutes: number | null | undefined,
  tolerances: AdjustedTolerances = DEFAULT_ADJUSTED_TOLERANCES,
): KpiRating | null {
  if (varianceMinutes == null || !Number.isFinite(varianceMinutes)) return null;
  const v = Math.round(varianceMinutes);

  if (v <= 0) return 'EXCELLENT';
  if (v <= tolerances.meetsToleranceMinutes) return 'MEETS_TARGET';
  if (v <= tolerances.needsImprovementToleranceMinutes) return 'NEEDS_IMPROVEMENT';
  return 'BELOW_STANDARD';
}

/** A rating counts as on-target when it is Excellent or Meets Target. */
export function isOnTarget(rating: KpiRating | null): boolean {
  return rating === 'EXCELLENT' || rating === 'MEETS_TARGET';
}

/**
 * Minutes still available before the next tolerance boundary is crossed, for the
 * live "18 min before Needs Improvement" readout on the technician card. Null once
 * the job is already in the bottom band — there is no next boundary.
 */
export function minutesToNextBoundary(
  varianceMinutes: number,
  tolerances: AdjustedTolerances = DEFAULT_ADJUSTED_TOLERANCES,
): { nextRating: KpiRating; minutesRemaining: number } | null {
  const v = Math.round(varianceMinutes);

  if (v <= 0) {
    return { nextRating: 'MEETS_TARGET', minutesRemaining: -v + 1 };
  }
  if (v <= tolerances.meetsToleranceMinutes) {
    return {
      nextRating: 'NEEDS_IMPROVEMENT',
      minutesRemaining: tolerances.meetsToleranceMinutes - v + 1,
    };
  }
  if (v <= tolerances.needsImprovementToleranceMinutes) {
    return {
      nextRating: 'BELOW_STANDARD',
      minutesRemaining: tolerances.needsImprovementToleranceMinutes - v + 1,
    };
  }
  return null;
}

function isUsableMinutes(m: number | null | undefined): boolean {
  return m != null && Number.isFinite(m) && m > 0;
}
