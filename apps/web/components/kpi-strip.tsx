'use client';

/**
 * CR-2026-088 — the live KPI strip on a job card.
 *
 * Shows a technician where they stand against the standard for THIS vehicle class
 * and package, while the job is running: standard, elapsed, minutes remaining,
 * variance, and the rating they are currently on course for.
 *
 * Once the standard is passed it switches to counting down to the NEXT tolerance
 * boundary — "12 min over · Meets Target · 18 min before Needs Improvement" — because
 * "you are already late" is not actionable, whereas "you have 18 minutes before this
 * drops a band" is.
 *
 * Never rendered on the customer display. A technician's performance rating is
 * management information, not something a customer in the lobby should read.
 */

export type KpiRating = 'EXCELLENT' | 'MEETS_TARGET' | 'NEEDS_IMPROVEMENT' | 'BELOW_STANDARD';

export const KPI_RATING_LABEL: Record<KpiRating, string> = {
  EXCELLENT: 'Excellent',
  MEETS_TARGET: 'Meets Target',
  NEEDS_IMPROVEMENT: 'Needs Improvement',
  BELOW_STANDARD: 'Below Standard',
};

export const KPI_RATING_BADGE: Record<KpiRating, string> = {
  EXCELLENT: 'bg-emerald-100 text-emerald-800',
  MEETS_TARGET: 'bg-blue-100 text-blue-800',
  NEEDS_IMPROVEMENT: 'bg-amber-100 text-amber-800',
  BELOW_STANDARD: 'bg-red-100 text-red-800',
};

export const KPI_PACKAGE_LABEL: Record<string, string> = {
  GENERAL_SERVICE_ONLY: 'General Service',
  GENERAL_SERVICE_FRONT_BRAKES: 'General Service + Front Brakes',
  GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS: 'General Service + Front Brakes + Spark Plugs',
  CUSTOM_UNBENCHMARKED: 'Custom (not benchmarked)',
};

export const VEHICLE_CLASS_LABEL: Record<string, string> = {
  SEDAN_CLASS: 'Sedan',
  SUV_CLASS: 'SUV',
  UNKNOWN_REQUIRES_REVIEW: 'Class not set',
};

export interface LiveKpi {
  vehicleClass: string | null;
  packageType: string;
  packageReason: string | null;
  standardMinutes: number | null;
  minutesRemaining: number | null;
  kpiCompletionMinutes: number | null;
  rawElapsedMinutes: number | null;
  approvedExcludedMinutes: number;
  varianceMinutes: number | null;
  adjustedTechnicianRating: KpiRating | null;
  absoluteCompletionRating: KpiRating | null;
  inFlight: boolean;
}

/** Tolerances mirror the seeded policy defaults; the API is the source of truth. */
const MEETS_TOLERANCE = 30;
const NEEDS_TOLERANCE = 60;

function nextBoundary(variance: number): { label: string; minutes: number } | null {
  if (variance <= 0) return { label: 'Meets Target', minutes: -variance + 1 };
  if (variance <= MEETS_TOLERANCE) {
    return { label: 'Needs Improvement', minutes: MEETS_TOLERANCE - variance + 1 };
  }
  if (variance <= NEEDS_TOLERANCE) {
    return { label: 'Below Standard', minutes: NEEDS_TOLERANCE - variance + 1 };
  }
  return null;
}

export function KpiStrip({
  kpi,
  compact = false,
  hadRework = false,
  delayPending = false,
}: {
  kpi: LiveKpi | null | undefined;
  compact?: boolean;
  hadRework?: boolean;
  delayPending?: boolean;
}) {
  if (!kpi) return null;

  const cls = kpi.vehicleClass ? VEHICLE_CLASS_LABEL[kpi.vehicleClass] ?? kpi.vehicleClass : null;
  const pkg = KPI_PACKAGE_LABEL[kpi.packageType] ?? kpi.packageType;
  const rating = kpi.adjustedTechnicianRating;
  const variance = kpi.varianceMinutes;

  // No agreed standard means no countdown and no projected rating. Say so plainly
  // rather than showing a number the job was never measured against.
  if (kpi.standardMinutes == null) {
    return (
      <div className={`rounded-lg border border-slate-200 bg-slate-50 ${compact ? 'px-3 py-2' : 'p-3'}`}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {cls && <span className="badge bg-slate-200 text-slate-700">{cls}</span>}
          <span className="font-medium text-slate-700">{pkg}</span>
        </div>
        <p className="text-[11px] text-slate-500 mt-1">
          {kpi.packageReason ?? 'No agreed standard time, so this job is not rated.'}
        </p>
      </div>
    );
  }

  const boundary = variance != null ? nextBoundary(variance) : null;
  const overStandard = variance != null && variance > 0;

  return (
    <div className={`rounded-lg border border-slate-200 bg-white ${compact ? 'px-3 py-2' : 'p-3'}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {cls && <span className="badge bg-slate-200 text-slate-700">{cls}</span>}
        <span className="font-medium text-slate-800">{pkg}</span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-600 tabular-nums">Standard {kpi.standardMinutes} min</span>
        {kpi.kpiCompletionMinutes != null && (
          <>
            <span className="text-slate-400">·</span>
            <span className="text-slate-600 tabular-nums">
              Elapsed {kpi.kpiCompletionMinutes} min
            </span>
          </>
        )}
        {kpi.approvedExcludedMinutes > 0 && (
          <span className="text-[11px] text-slate-400 tabular-nums">
            ({kpi.approvedExcludedMinutes} min excluded)
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-1.5">
        {!overStandard && kpi.minutesRemaining != null && kpi.minutesRemaining >= 0 && (
          <span className="text-xs font-semibold text-emerald-700 tabular-nums">
            {kpi.minutesRemaining} min remaining
          </span>
        )}
        {overStandard && (
          <span className="text-xs font-semibold text-amber-700 tabular-nums">
            {variance} min over standard
          </span>
        )}
        {rating && (
          <span className={`badge text-[11px] ${KPI_RATING_BADGE[rating]}`}>
            {kpi.inFlight ? 'On course for ' : ''}
            {KPI_RATING_LABEL[rating]}
          </span>
        )}
        {kpi.inFlight && boundary && (
          <span className="text-[11px] text-slate-500 tabular-nums">
            {boundary.minutes} min before {boundary.label}
          </span>
        )}
      </div>

      {(delayPending || hadRework) && (
        <div className="flex flex-wrap gap-2 mt-1.5">
          {delayPending && (
            <span className="badge bg-amber-50 text-amber-800 text-[10px]">
              Delay awaiting approval
            </span>
          )}
          {/* An excellent time with a failed quality check must never read as an
              unqualified top result. */}
          {hadRework && (
            <span className="badge bg-red-50 text-red-700 text-[10px]">
              Came back from QC
            </span>
          )}
        </div>
      )}
    </div>
  );
}
