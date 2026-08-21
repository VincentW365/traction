/**
 * CR-2026-086 — technician KPI rating bands and package standard times.
 *
 * Supplied by the service manager:
 *
 *   Completion time      Rating
 *   ≤ 2.00 hrs           Excellent
 *   2.01 – 2.50 hrs      Meets Target
 *   2.51 – 3.00 hrs      Needs Improvement
 *   > 3.00 hrs           Below Standard
 *
 *   Package                                          Standard time
 *   General Service Only                             1.5 hrs
 *   General Service + Front Brakes                   2.0 hrs
 *   General Service + Front Brakes + Spark Plugs     2.5 hrs
 *
 * Both tables are DEFAULTS ONLY. They are seeded into BusinessRuleConfig
 * (`kpi_rating_bands`, `kpi_package_standard_hours`) so a manager can retune them
 * without a deploy — per CLAUDE.md, rule values must not be hard-coded. The
 * constants below are the fallback used when a site has no override configured.
 *
 * Pure functions: no database, no side effects.
 */

export type KpiRating =
  | 'EXCELLENT'
  | 'MEETS_TARGET'
  | 'NEEDS_IMPROVEMENT'
  | 'BELOW_STANDARD';

export interface KpiBand {
  /** Inclusive upper bound in hours. `null` = the open-ended final band. */
  maxHours: number | null;
  rating: KpiRating;
}

/** Bands must be ordered fastest-first, ending with the open-ended band. */
export const DEFAULT_KPI_BANDS: KpiBand[] = [
  { maxHours: 2.0, rating: 'EXCELLENT' },
  { maxHours: 2.5, rating: 'MEETS_TARGET' },
  { maxHours: 3.0, rating: 'NEEDS_IMPROVEMENT' },
  { maxHours: null, rating: 'BELOW_STANDARD' },
];

export const KPI_RATING_LABELS: Record<KpiRating, string> = {
  EXCELLENT: 'Excellent',
  MEETS_TARGET: 'Meets Target',
  NEEDS_IMPROVEMENT: 'Needs Improvement',
  BELOW_STANDARD: 'Below Standard',
};

/** Package standard times, in hours. */
export const DEFAULT_PACKAGE_STANDARD_HOURS: Record<string, number> = {
  GENERAL_SERVICE: 1.5,
  GENERAL_SERVICE_FRONT_BRAKES: 2.0,
  GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS: 2.5,
};

/**
 * Rate a completion time against the bands.
 *
 * Note the boundaries are INCLUSIVE upper bounds, matching the manager's table:
 * exactly 2.00 hrs is Excellent, and 2.01 starts Meets Target. Working in minutes
 * avoids the floating-point trap where 2.5 hrs fails a `< 2.5` test.
 *
 * @param minutes actual completion time in minutes. Null/negative/zero → null,
 *                because "no time recorded" is not a performance result.
 */
export function rateCompletionMinutes(
  minutes: number | null | undefined,
  bands: KpiBand[] = DEFAULT_KPI_BANDS,
): KpiRating | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;

  const ordered = [...bands].sort((a, b) => {
    if (a.maxHours == null) return 1;
    if (b.maxHours == null) return -1;
    return a.maxHours - b.maxHours;
  });

  for (const band of ordered) {
    if (band.maxHours == null) return band.rating;
    // Round to whole minutes so 2.0 hrs === 120 min compares exactly.
    if (minutes <= Math.round(band.maxHours * 60)) return band.rating;
  }

  return ordered[ordered.length - 1]?.rating ?? null;
}

/**
 * Parse operator-supplied band config, falling back to the defaults on anything
 * malformed. Settings is a raw JSON editor, so this must never throw.
 */
export function parseKpiBands(value: unknown): KpiBand[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_KPI_BANDS;

  const valid: KpiBand[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { maxHours, rating } = entry as { maxHours?: unknown; rating?: unknown };
    if (typeof rating !== 'string' || !(rating in KPI_RATING_LABELS)) continue;
    if (maxHours === null || maxHours === undefined) {
      valid.push({ maxHours: null, rating: rating as KpiRating });
    } else if (typeof maxHours === 'number' && Number.isFinite(maxHours) && maxHours > 0) {
      valid.push({ maxHours, rating: rating as KpiRating });
    }
  }

  // Unusable without an open-ended final band — every time must land somewhere.
  if (valid.length === 0 || !valid.some((b) => b.maxHours == null)) return DEFAULT_KPI_BANDS;
  return valid;
}
