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
 * CR-2026-103 — the same strip runs on the dispatch board, where a bay card is a
 * quarter of a row wide, hence the `dense` variant: the rating and the countdown keep
 * their own line and everything descriptive is abbreviated onto one truncated line.
 *
 * A job that cannot be rated says so and says why (`kpiNotRated`). It must never fall
 * back to a blank strip or a zero — a rating nobody may act on is worse than none, and
 * the reader cannot tell an unrated job from a fast one by looking at empty space.
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

/** Dispatch-board wording: a bay card cannot hold the full package name. */
export const KPI_PACKAGE_SHORT_LABEL: Record<string, string> = {
  GENERAL_SERVICE_ONLY: 'Gen. Service',
  GENERAL_SERVICE_FRONT_BRAKES: 'Gen. Service + Brakes',
  GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS: 'Gen. Service + Brakes + Plugs',
  CUSTOM_UNBENCHMARKED: 'Custom',
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

export type KpiStripVariant = 'full' | 'compact' | 'dense';

export type KpiNotRatedCode =
  | 'NOT_STARTED'
  | 'MISSING_VEHICLE_CLASS'
  | 'NOT_BENCHMARKED'
  | 'SHARED_OR_REASSIGNED';

export interface KpiNotRated {
  code: KpiNotRatedCode;
  /** Short enough to sit in a badge on a bay card. */
  label: string;
  detail: string;
}

/**
 * Why this job carries no rating, or null when it does.
 *
 * The order mirrors the API's own eligibility precedence — start times, then vehicle
 * class, then benchmark — so a live job gives the same answer it will give once the
 * result is filed. Shared work is appended because the live endpoint measures one job
 * clock and cannot see that more than one technician was on it; the caller supplies
 * that from the labour measures.
 *
 * A shared or reassigned job keeps its job time and loses only the rating: no formula
 * splits one elapsed clock between the people who worked it, so any individual figure
 * here would be an invention presented as a measurement (CR-2026-090).
 */
export function kpiNotRated(
  kpi: LiveKpi,
  opts?: { technicianCount?: number },
): KpiNotRated | null {
  const technicianCount = opts?.technicianCount ?? 1;

  if (kpi.rawElapsedMinutes == null) {
    return {
      code: 'NOT_STARTED',
      label: 'Not started',
      detail: 'No work time is recorded against this job yet.',
    };
  }
  if (kpi.vehicleClass == null) {
    return {
      code: 'MISSING_VEHICLE_CLASS',
      label: 'Class not confirmed',
      detail:
        'The vehicle is not confirmed as a Sedan or an SUV, so there is no standard to measure against.',
    };
  }
  if (kpi.standardMinutes == null) {
    return {
      code: 'NOT_BENCHMARKED',
      label: 'No agreed standard',
      detail: kpi.packageReason ?? 'This combination of services has no agreed standard time.',
    };
  }
  if (technicianCount > 1) {
    return {
      code: 'SHARED_OR_REASSIGNED',
      label: 'Shared job',
      detail: `Worked by ${technicianCount} technicians — job time only, never an individual rating.`,
    };
  }
  return null;
}

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
  variant = 'full',
  technicianCount,
  hadRework = false,
  delayPending = false,
}: {
  kpi: LiveKpi | null | undefined;
  variant?: KpiStripVariant;
  /** From the labour measures. More than one technician means no individual rating. */
  technicianCount?: number;
  hadRework?: boolean;
  delayPending?: boolean;
}) {
  if (!kpi) return null;

  const dense = variant === 'dense';
  const pad = variant === 'full' ? 'p-3' : 'px-3 py-2';
  const cls = kpi.vehicleClass ? VEHICLE_CLASS_LABEL[kpi.vehicleClass] ?? kpi.vehicleClass : null;
  const pkg = dense
    ? KPI_PACKAGE_SHORT_LABEL[kpi.packageType] ?? kpi.packageType
    : KPI_PACKAGE_LABEL[kpi.packageType] ?? kpi.packageType;
  const rating = kpi.adjustedTechnicianRating;
  const variance = kpi.varianceMinutes;
  const notRated = kpiNotRated(kpi, { technicianCount });

  if (notRated) {
    return (
      <div className={`rounded-lg border border-slate-200 bg-slate-50 ${pad}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge bg-slate-200 text-slate-700 text-[10px]">
            Not rated · {notRated.label}
          </span>
          {!dense && cls && <span className="badge bg-slate-200 text-slate-700 text-[11px]">{cls}</span>}
          {!dense && <span className="text-xs font-medium text-slate-700">{pkg}</span>}
        </div>
        <p className={`${dense ? 'text-[10px]' : 'text-[11px]'} text-slate-500 mt-1`}>{notRated.detail}</p>
        {/* Elapsed time is a fact about the job even where nobody may be rated on it,
            so it stays — labelled as time, never as a result. */}
        {kpi.kpiCompletionMinutes != null && (
          <p className={`${dense ? 'text-[10px]' : 'text-[11px]'} text-slate-400 tabular-nums mt-0.5`}>
            {kpi.standardMinutes != null && `Standard ${kpi.standardMinutes} min · `}
            Elapsed {kpi.kpiCompletionMinutes} min
          </p>
        )}
      </div>
    );
  }

  const boundary = variance != null ? nextBoundary(variance) : null;
  const overStandard = variance != null && variance > 0;

  if (dense) {
    const facts = [
      cls,
      pkg,
      kpi.standardMinutes != null ? `std ${kpi.standardMinutes}m` : null,
      kpi.kpiCompletionMinutes != null ? `${kpi.kpiCompletionMinutes}m elapsed` : null,
      kpi.inFlight && boundary ? `${boundary.minutes}m to ${boundary.label}` : null,
    ].filter(Boolean);

    return (
      <div className={`rounded-lg border border-slate-200 bg-white ${pad}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          {rating && (
            <span className={`badge text-[10px] ${KPI_RATING_BADGE[rating]}`}>
              {kpi.inFlight ? 'On course for ' : ''}
              {KPI_RATING_LABEL[rating]}
            </span>
          )}
          {!overStandard && kpi.minutesRemaining != null && kpi.minutesRemaining >= 0 && (
            <span className="text-[11px] font-semibold text-emerald-700 tabular-nums">
              {kpi.minutesRemaining}m left
            </span>
          )}
          {overStandard && (
            <span className="text-[11px] font-semibold text-amber-700 tabular-nums">{variance}m over</span>
          )}
          {delayPending && <span className="badge bg-amber-50 text-amber-800 text-[10px]">Delay pending</span>}
          {hadRework && <span className="badge bg-red-50 text-red-700 text-[10px]">Came back from QC</span>}
        </div>
        <p className="text-[10px] text-slate-500 tabular-nums truncate mt-0.5">{facts.join(' · ')}</p>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border border-slate-200 bg-white ${pad}`}>
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
