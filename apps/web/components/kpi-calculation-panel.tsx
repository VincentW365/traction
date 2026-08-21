/**
 * CR-2026-092 — how a job's KPI standard was arrived at, shown line by line.
 *
 * A technician measured against a number they cannot derive will not trust it, and a
 * manager cannot defend it in a review. This panel is the arithmetic made visible:
 * the base package allowance, every service that extended it, every service that did
 * not, and the final standard those add up to.
 *
 * Three distinctions carry the whole design and must never collapse into a bare "0":
 *
 *   Included       inside the package allowance already — adds nothing, and must not
 *                  read as "we allowed you no time for this"
 *   Separate SLA   not technician repair time at all — measured on its own clock, so
 *                  it neither extends this standard nor voids it
 *   Suppressed     a second catalogue code describing work already counted once
 *
 * Presentational only. Every figure is supplied by the caller; nothing is recomputed
 * here, because two implementations of the same arithmetic will eventually disagree
 * and the screen would then contradict the filed result.
 */

export interface KpiCalculationLine {
  serviceCode: string;
  serviceName: string;
  mode: 'PACKAGE_COMPONENT' | 'INCLUDED_IN_BASE' | 'ADDITIVE_STANDARD' | 'SEPARATE_SLA' | 'CUSTOM_ONLY';
  minutes: number;
  qualifierLabel: string | null;
  provisional: boolean;
  suppressedAsDuplicate?: boolean;
  note: string | null;
}

export interface KpiCalculationBreakdown {
  packageLabel: string | null;
  basePackageMinutes: number | null;
  lines: KpiCalculationLine[];
  additiveMinutes: number;
  finalStandardMinutes: number | null;
  benchmarkSource:
    | 'MANAGER_PACKAGE'
    | 'MANAGER_PACKAGE_PLUS_ADDITIVES'
    | 'CATALOG_COMPOSITE'
    | 'MANAGER_CUSTOM'
    | 'NOT_TECHNICIAN_RATED';
  vehicleClass: string | null;
  provisionalDurationsUsed: boolean;
  missingQualifiers: Array<{ serviceCode: string; message: string }>;
}

const BENCHMARK_SOURCE_LABEL: Record<KpiCalculationBreakdown['benchmarkSource'], string> = {
  MANAGER_PACKAGE: 'Manager package standard',
  MANAGER_PACKAGE_PLUS_ADDITIVES: 'Manager package + additives',
  CATALOG_COMPOSITE: 'Catalogue composite',
  MANAGER_CUSTOM: 'Manager custom standard',
  NOT_TECHNICIAN_RATED: 'Not technician-rated',
};

const BENCHMARK_SOURCE_BADGE: Record<KpiCalculationBreakdown['benchmarkSource'], string> = {
  MANAGER_PACKAGE: 'bg-blue-100 text-blue-800',
  MANAGER_PACKAGE_PLUS_ADDITIVES: 'bg-blue-100 text-blue-800',
  CATALOG_COMPOSITE: 'bg-slate-200 text-slate-700',
  MANAGER_CUSTOM: 'bg-violet-100 text-violet-800',
  NOT_TECHNICIAN_RATED: 'bg-slate-200 text-slate-600',
};

const VEHICLE_CLASS_LABEL: Record<string, string> = {
  SEDAN_CLASS: 'Sedan',
  SUV_CLASS: 'SUV',
  UNKNOWN_REQUIRES_REVIEW: 'Class not set',
};

const RATING_BADGE: Record<string, string> = {
  EXCELLENT: 'bg-emerald-100 text-emerald-800',
  MEETS_TARGET: 'bg-blue-100 text-blue-800',
  NEEDS_IMPROVEMENT: 'bg-amber-100 text-amber-800',
  BELOW_STANDARD: 'bg-red-100 text-red-800',
};

const RATING_LABEL: Record<string, string> = {
  EXCELLENT: 'Excellent',
  MEETS_TARGET: 'Meets Target',
  NEEDS_IMPROVEMENT: 'Needs Improvement',
  BELOW_STANDARD: 'Below Standard',
};

/**
 * The right-hand column. Words beat numbers for the three non-additive modes: a reader
 * scanning a column of minutes reads "0" as "no allowance", which is the opposite of
 * what INCLUDED_IN_BASE and SEPARATE_SLA mean.
 */
function lineValue(line: KpiCalculationLine): string {
  switch (line.mode) {
    case 'INCLUDED_IN_BASE':
      return 'Included';
    case 'SEPARATE_SLA':
      return 'Separate SLA';
    case 'PACKAGE_COMPONENT':
      return 'In package';
    case 'CUSTOM_ONLY':
      return `${line.minutes}`;
    case 'ADDITIVE_STANDARD':
      return `+${line.minutes}`;
  }
}

function valueTone(line: KpiCalculationLine): string {
  if (line.suppressedAsDuplicate) return 'text-slate-400 line-through';
  if (line.mode === 'ADDITIVE_STANDARD' || line.mode === 'CUSTOM_ONLY') {
    return 'text-slate-900 font-semibold';
  }
  return 'text-slate-500 font-medium';
}

export function KpiCalculationPanel({
  breakdown,
  elapsedMinutes,
  projectedRating,
}: {
  breakdown: KpiCalculationBreakdown;
  elapsedMinutes?: number;
  projectedRating?: string | null;
}) {
  const cls = breakdown.vehicleClass
    ? VEHICLE_CLASS_LABEL[breakdown.vehicleClass] ?? breakdown.vehicleClass
    : null;
  const final = breakdown.finalStandardMinutes;

  // Only meaningful against an agreed standard; an elapsed clock with no standard to
  // measure it by is a fact about the job, not a result, and belongs on the strip.
  const showProgress = elapsedMinutes != null && final != null;
  const variance = showProgress ? elapsedMinutes - final : null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          Calculated Standard
        </h4>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="badge bg-slate-200 text-slate-700 text-[10px]">
            {cls ?? 'Class not set'}
          </span>
          <span className={`badge text-[10px] ${BENCHMARK_SOURCE_BADGE[breakdown.benchmarkSource]}`}>
            {BENCHMARK_SOURCE_LABEL[breakdown.benchmarkSource]}
          </span>
        </div>
      </div>

      <div className="px-4 py-3">
        <dl className="divide-y divide-slate-100">
          {breakdown.packageLabel && (
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-sm font-semibold text-slate-900">{breakdown.packageLabel}</dt>
              <dd className="shrink-0 text-sm font-semibold text-slate-900 tabular-nums">
                {breakdown.basePackageMinutes != null ? breakdown.basePackageMinutes : '—'}
              </dd>
            </div>
          )}

          {breakdown.lines.map((line) => (
            <div key={line.serviceCode} className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="min-w-0">
                <span
                  className={`text-sm ${
                    line.suppressedAsDuplicate
                      ? 'text-slate-400 line-through'
                      : 'text-slate-800'
                  }`}
                >
                  {line.serviceName}
                </span>
                <span className="ml-1.5 font-mono text-[10px] text-slate-400">{line.serviceCode}</span>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {line.qualifierLabel && (
                    <span className="badge bg-slate-100 text-slate-600 text-[10px]">
                      {line.qualifierLabel}
                    </span>
                  )}
                  {line.provisional && (
                    <span className="badge bg-amber-100 text-amber-800 text-[10px]">
                      Provisional duration
                    </span>
                  )}
                  {line.suppressedAsDuplicate && (
                    <span className="badge bg-slate-200 text-slate-600 text-[10px]">
                      Not counted twice
                    </span>
                  )}
                </div>
                {line.note && (
                  <p
                    className={`mt-0.5 text-[11px] ${
                      line.suppressedAsDuplicate ? 'text-slate-400' : 'text-slate-500'
                    }`}
                  >
                    {line.note}
                  </p>
                )}
              </dt>
              <dd className={`shrink-0 text-sm tabular-nums ${valueTone(line)}`}>
                {lineValue(line)}
              </dd>
            </div>
          ))}
        </dl>

        {breakdown.additiveMinutes > 0 && (
          <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-slate-100 pt-2 text-xs text-slate-500">
            <span>Additive time</span>
            <span className="tabular-nums">+{breakdown.additiveMinutes}</span>
          </div>
        )}

        <div className="mt-2 flex items-baseline justify-between gap-4 border-t-2 border-slate-300 pt-2">
          <span className="text-sm font-bold text-slate-900">Final KPI Standard</span>
          {final != null ? (
            <span className="text-base font-bold text-slate-900 tabular-nums">{final}</span>
          ) : (
            <span className="text-sm font-semibold text-slate-500">No agreed standard</span>
          )}
        </div>

        {showProgress && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-slate-50 px-3 py-2">
            <span className="text-xs text-slate-600 tabular-nums">
              Elapsed <span className="font-semibold text-slate-900">{elapsedMinutes}</span> min
            </span>
            {variance != null && variance <= 0 ? (
              <span className="text-xs font-semibold text-emerald-700 tabular-nums">
                {-variance} min remaining
              </span>
            ) : (
              <span className="text-xs font-semibold text-amber-700 tabular-nums">
                {variance} min over standard
              </span>
            )}
            {projectedRating && (
              <span className={`badge text-[10px] ${RATING_BADGE[projectedRating] ?? 'bg-slate-200 text-slate-700'}`}>
                On course for {RATING_LABEL[projectedRating] ?? projectedRating}
              </span>
            )}
          </div>
        )}

        {breakdown.provisionalDurationsUsed && (
          <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-900">Provisional durations used</p>
            <p className="mt-0.5 text-[11px] text-amber-800">
              At least one service on this job has no agreed standard time yet, so a provisional
              figure stands in. Treat the result as indicative until a manager confirms the duration.
            </p>
          </div>
        )}

        {/* Actionable, not merely informative: the qualifier is missing data somebody can
            still supply, and until they do the standard below is incomplete. */}
        {breakdown.missingQualifiers.length > 0 && (
          <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-900">
              {breakdown.missingQualifiers.length === 1
                ? 'A qualifier is needed before this job can be measured'
                : `${breakdown.missingQualifiers.length} qualifiers are needed before this job can be measured`}
            </p>
            <ul className="mt-1 space-y-0.5">
              {breakdown.missingQualifiers.map((q) => (
                <li key={q.serviceCode} className="text-[11px] text-amber-800">
                  <span className="font-mono text-[10px] text-amber-700">{q.serviceCode}</span> — {q.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
