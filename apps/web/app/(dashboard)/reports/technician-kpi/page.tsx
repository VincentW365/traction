'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../lib/export';
import {
  KPI_RATING_LABEL,
  KPI_RATING_BADGE,
  KPI_PACKAGE_LABEL,
  VEHICLE_CLASS_LABEL,
  type KpiRating,
} from '../../../../components/kpi-strip';

/**
 * CR-2026-088 — manager KPI dashboard.
 *
 * Two ratings are shown side by side and never merged. The scope-adjusted rating is
 * the one to compare technicians on; the absolute rating is the manager's original
 * fixed completion bands, kept so both questions can still be asked.
 *
 * Median and percentiles sit next to the averages deliberately. One job that sat
 * overnight waiting for a part will drag a mean into Below Standard and hide an
 * otherwise steady month; the median says what a typical job looks like and p90 says
 * how bad the tail gets.
 */

const ALLOWED_ROLES = ['ADMIN'];

interface Dashboard {
  eligibleJobs: number;
  totalJobs: number;
  adjustedOnTargetPercent: number;
  excellentPercent: number;
  meetsTargetPercent: number;
  needsImprovementPercent: number;
  belowStandardPercent: number;
  averageKpiMinutes: number | null;
  medianKpiMinutes: number | null;
  p75KpiMinutes: number | null;
  p90KpiMinutes: number | null;
  averageVarianceMinutes: number | null;
  medianVarianceMinutes: number | null;
  firstPassQcPercent: number;
  reworkRate: number;
  byVehicleClass: Record<string, number>;
  byPackage: Record<string, number>;
  byAbsoluteRating: Record<string, number>;
  byIneligibility: Record<string, number>;
  unbenchmarkedJobs: number;
  sharedOrReassignedJobs: number;
  // CR-2026-091 — unrated because configuration is missing, not because the work has
  // no standard. An outstanding task rather than a conclusion.
  pendingBenchmarkReviewJobs: number;
  byTechnician: TechnicianRow[];
  approvedExclusionMinutesByReason: Array<{ reasonCode: string; minutes: number; events: number }>;
}

/**
 * Per-technician numbers come from the API, which owns the rule about what counts.
 * Rolling them up here from the job rows would repeat that rule in a second place and
 * cap it at whatever the job table happened to fetch.
 */
interface TechnicianRow {
  technicianId: string;
  technicianCode: string | null;
  technicianName: string | null;
  jobs: number;
  onTarget: number;
  onTargetPercent: number;
  medianVarianceMinutes: number | null;
  p75VarianceMinutes: number | null;
  excludedPendingReview: number;
  excludedSharedOrReassigned: number;
}

interface JobRow {
  serviceOrderId: string;
  ticketNumber: string | null;
  plate: string | null;
  technicianCode: string | null;
  technicianName: string | null;
  vehicleClass: string | null;
  packageType: string;
  standardMinutes: number | null;
  rawElapsedMinutes: number | null;
  approvedExcludedMinutes: number;
  kpiCompletionMinutes: number | null;
  varianceMinutes: number | null;
  variancePercent: number | null;
  absoluteCompletionRating: KpiRating | null;
  adjustedTechnicianRating: KpiRating | null;
  onTarget: boolean;
  eligibilityStatus: string;
  eligibilityReason: string | null;
  pendingBenchmarkReview: boolean;
  benchmarkResolvedAt: string | null;
  isSharedOrReassigned: boolean;
  hadRework: boolean;
  policyVersion: number;
  firstWorkStartedAt: string | null;
  firstSubmittedToQcAt: string | null;
}

function localISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISO(d);
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="input-label">{label}</div>
      <div className="text-2xl font-bold text-slate-900 tabular-nums mt-0.5">{value}</div>
      {hint && <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>}
    </div>
  );
}

export default function TechnicianKpiPage() {
  const { user } = useAuth();
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(localISO(new Date()));
  const [vehicleClass, setVehicleClass] = useState('');
  const [packageType, setPackageType] = useState('');
  const [adjustedRating, setAdjustedRating] = useState('');
  const [benchmarkedOnly, setBenchmarkedOnly] = useState(false);
  const [minJobs, setMinJobs] = useState(5);

  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');

  const qs = new URLSearchParams({
    from,
    to,
    ...(vehicleClass && { vehicleClass }),
    ...(packageType && { packageType }),
    ...(adjustedRating && { adjustedRating }),
    ...(benchmarkedOnly && { benchmarkedOnly: 'true' }),
  }).toString();

  const dash = useQuery<Dashboard>({
    queryKey: ['kpi-dashboard', qs],
    queryFn: () => api.get(`/kpi/dashboard?${qs}`),
    enabled: allowed,
  });
  const jobs = useQuery<JobRow[]>({
    queryKey: ['kpi-jobs', qs],
    queryFn: () => api.get(`/kpi/dashboard/jobs?${qs}`),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Technician KPI" subtitle="Manager report" />
        <div className="card p-6 text-sm text-slate-600">
          You do not have permission to view this report.
        </div>
      </div>
    );
  }

  const d = dash.data;
  const rows = jobs.data ?? [];

  // Straight from the API. What counts towards a technician's numbers is a domain
  // rule, and it belongs in one place — a job held for benchmark review is out of the
  // denominator because nobody had said what to measure it against, not because of
  // anything a report page should be deciding.
  const techRows = (d?.byTechnician ?? []).map((t) => ({
    ...t,
    name: t.technicianName ?? t.technicianCode ?? t.technicianId,
    code: t.technicianCode ?? '--',
    medianVariance: t.medianVarianceMinutes,
    belowThreshold: t.jobs < minJobs,
  }));

  const buildExport = (): ExportDocument | null => {
    if (!d) return null;
    return {
      filename: 'technician-kpi',
      title: 'Technician KPI',
      subtitle: `${from} to ${to}`,
      sections: [
        {
          heading: 'Summary',
          columns: ['Metric', 'Value'],
          rows: [
            ['Eligible completed jobs', d.eligibleJobs],
            ['Total jobs in range', d.totalJobs],
            ['Adjusted on-target %', `${d.adjustedOnTargetPercent}%`],
            ['Excellent %', `${d.excellentPercent}%`],
            ['Meets Target %', `${d.meetsTargetPercent}%`],
            ['Needs Improvement %', `${d.needsImprovementPercent}%`],
            ['Below Standard %', `${d.belowStandardPercent}%`],
            ['Average KPI minutes', d.averageKpiMinutes ?? '--'],
            ['Median KPI minutes', d.medianKpiMinutes ?? '--'],
            ['75th percentile minutes', d.p75KpiMinutes ?? '--'],
            ['90th percentile minutes', d.p90KpiMinutes ?? '--'],
            ['Average minutes vs standard', d.averageVarianceMinutes ?? '--'],
            ['First-pass QC %', `${d.firstPassQcPercent}%`],
            ['Rework rate', `${d.reworkRate}%`],
            ['Unbenchmarked jobs', d.unbenchmarkedJobs],
            ['Shared / reassigned jobs', d.sharedOrReassignedJobs],
          ],
        },
        {
          heading: 'Approved exclusion minutes by reason',
          columns: ['Reason', 'Events', 'Minutes'],
          rows: d.approvedExclusionMinutesByReason.map((e) => [e.reasonCode, e.events, e.minutes]),
        },
        {
          // The job-level rows carry the policy version, so this export can be
          // reconciled months later even after the standards change.
          heading: 'Job-level KPI calculation',
          columns: [
            'Ticket', 'Plate', 'Technician', 'Class', 'Package', 'Standard',
            'Raw elapsed', 'Excluded', 'KPI minutes', 'Variance', 'Variance %',
            'Adjusted', 'Absolute', 'Rework', 'Shared', 'Eligibility', 'Policy v',
          ],
          rows: rows.map((r) => [
            r.ticketNumber ?? '', r.plate ?? '', r.technicianCode ?? '',
            r.vehicleClass ? VEHICLE_CLASS_LABEL[r.vehicleClass] ?? r.vehicleClass : '',
            KPI_PACKAGE_LABEL[r.packageType] ?? r.packageType,
            r.standardMinutes ?? '', r.rawElapsedMinutes ?? '', r.approvedExcludedMinutes,
            r.kpiCompletionMinutes ?? '', r.varianceMinutes ?? '', r.variancePercent ?? '',
            r.adjustedTechnicianRating ? KPI_RATING_LABEL[r.adjustedTechnicianRating] : '',
            r.absoluteCompletionRating ? KPI_RATING_LABEL[r.absoluteCompletionRating] : '',
            r.hadRework ? 'Yes' : 'No', r.isSharedOrReassigned ? 'Yes' : 'No',
            r.eligibilityStatus, r.policyVersion,
          ]),
        },
      ],
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Technician KPI"
        subtitle="Completion time against the standard for each vehicle class and package"
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Technician KPI' }]}
        actions={<ExportMenu build={buildExport} disabled={!d} />}
      />

      {/* Filters */}
      <div className="card p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="input-label">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="input-label">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="input-label">Vehicle class</label>
          <select value={vehicleClass} onChange={(e) => setVehicleClass(e.target.value)} className="input-field">
            <option value="">All</option>
            <option value="SEDAN_CLASS">Sedan</option>
            <option value="SUV_CLASS">SUV</option>
          </select>
        </div>
        <div>
          <label className="input-label">Package</label>
          <select value={packageType} onChange={(e) => setPackageType(e.target.value)} className="input-field">
            <option value="">All</option>
            {Object.entries(KPI_PACKAGE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="input-label">Adjusted rating</label>
          <select value={adjustedRating} onChange={(e) => setAdjustedRating(e.target.value)} className="input-field">
            <option value="">All</option>
            {Object.entries(KPI_RATING_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600 pb-2">
          <input type="checkbox" checked={benchmarkedOnly} onChange={(e) => setBenchmarkedOnly(e.target.checked)} />
          Benchmarked jobs only
        </label>
        <div>
          <label className="input-label">Min jobs to compare</label>
          <input
            type="number"
            min={1}
            value={minJobs}
            onChange={(e) => setMinJobs(Math.max(1, Number(e.target.value) || 1))}
            className="input-field w-24"
          />
        </div>
      </div>

      {dash.isLoading ? (
        <LoadingState message="Loading KPI results..." />
      ) : dash.isError ? (
        // CR-2026-100 — a failed request must never masquerade as an empty result.
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">
            Failed to load KPI results.
            {dash.error instanceof Error ? ` ${dash.error.message}` : ''}
          </p>
        </div>
      ) : !d || d.totalJobs === 0 ? (
        <div className="card p-6 text-sm text-slate-600">
          No completed jobs in this range yet. A job appears here once its technician
          submits it to QC.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat label="Eligible jobs" value={String(d.eligibleJobs)} hint={`${d.totalJobs} total in range`} />
            <Stat label="On target" value={`${d.adjustedOnTargetPercent}%`} hint="Excellent or Meets Target" />
            <Stat label="Median KPI time" value={d.medianKpiMinutes != null ? `${d.medianKpiMinutes} min` : '--'} hint={`avg ${d.averageKpiMinutes ?? '--'} min`} />
            <Stat label="First-pass QC" value={`${d.firstPassQcPercent}%`} hint={`rework ${d.reworkRate}%`} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat label="Excellent" value={`${d.excellentPercent}%`} />
            <Stat label="Meets Target" value={`${d.meetsTargetPercent}%`} />
            <Stat label="Needs Improvement" value={`${d.needsImprovementPercent}%`} />
            <Stat label="Below Standard" value={`${d.belowStandardPercent}%`} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Stat label="75th percentile" value={d.p75KpiMinutes != null ? `${d.p75KpiMinutes} min` : '--'} hint="3 in 4 finish inside this" />
            <Stat label="90th percentile" value={d.p90KpiMinutes != null ? `${d.p90KpiMinutes} min` : '--'} hint="how bad the tail gets" />
            <Stat label="Unbenchmarked" value={String(d.unbenchmarkedJobs)} hint="no agreed standard" />
            <Stat label="Shared / reassigned" value={String(d.sharedOrReassignedJobs)} hint="excluded from comparison" />
          </div>

          {/* CR-2026-091 — these are somebody's outstanding task, not a conclusion.
              Unrated jobs that nobody surfaces stay unrated for good. */}
          {d.pendingBenchmarkReviewJobs > 0 && (
            <div className="card mb-6 border-amber-200 bg-amber-50">
              <div className="card-body">
                <h2 className="text-sm font-semibold text-amber-900">
                  {d.pendingBenchmarkReviewJobs} job
                  {d.pendingBenchmarkReviewJobs === 1 ? '' : 's'} awaiting benchmark setup
                </h2>
                <p className="text-xs text-amber-800 mt-1 max-w-3xl">
                  These carry no rating at all — not even an absolute band — because a service
                  on them is not mapped to a benchmark component yet, or a brake line has no
                  axle recorded. The work was done; nobody has said what it should be measured
                  against. They are excluded from every technician&apos;s figures so an
                  administrative gap never reads as somebody&apos;s poor result.
                </p>
                <p className="text-xs text-amber-800 mt-2">
                  Once the mapping exists, each job can be rated for the first time.
                </p>
                <div className="mt-3 flex gap-2">
                  <Link href="/reports/benchmark-review" className="btn-secondary text-xs py-1 px-3">
                    Review queue
                  </Link>
                  <Link href="/admin/kpi-mapping" className="btn-secondary text-xs py-1 px-3">
                    KPI mapping
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Per technician */}
          <div className="table-container mb-6">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-900">By technician</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Ranked on the scope-adjusted rating. Shared and reassigned jobs are excluded here
                and shown in the job table below. A technician under {minJobs} job
                {minJobs === 1 ? '' : 's'} is marked as too small a sample to compare.
              </p>
            </div>
            {techRows.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-slate-500">
                No individually attributable jobs in this range.
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="table-header">
                    <th>Technician</th>
                    <th className="text-center">Jobs</th>
                    <th className="text-center">On target</th>
                    <th className="text-center">Median vs standard</th>
                  </tr>
                </thead>
                <tbody>
                  {techRows.map((t) => (
                    <tr key={t.code} className="border-b border-slate-50">
                      <td className="px-5 py-3">
                        <span className="text-sm font-medium text-slate-900">{t.name}</span>
                        <span className="block text-[11px] text-slate-400 font-mono">{t.code}</span>
                      </td>
                      <td className="text-center text-sm tabular-nums">
                        {t.jobs}
                        {t.belowThreshold && (
                          <span className="block text-[10px] text-amber-600">too few to compare</span>
                        )}
                      </td>
                      <td className="text-center text-sm tabular-nums">{t.onTargetPercent}%</td>
                      <td className="text-center text-sm tabular-nums">
                        {t.medianVariance == null
                          ? '--'
                          : t.medianVariance > 0
                            ? `+${t.medianVariance} min`
                            : `${t.medianVariance} min`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* CR-2026-090 — the jobs left out of the ranking above, named on the page
              that excludes them. Their absence is otherwise only inferable from a
              technician's job count being lower than the floor thinks it should be. */}
          <div className="card border-amber-200 bg-amber-50 p-4 mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-amber-900">Shared and reassigned jobs</h2>
              <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                {d.sharedOrReassignedJobs} job{d.sharedOrReassignedJobs === 1 ? '' : 's'} in this
                range had more than one technician on them. Informational only — not included in
                individual KPI comparison. Job time is wall-clock and there is one of it; labour
                time is per person, so a shared job carries more labour than it lasted. No
                per-technician rating is shown for them, because a job&apos;s elapsed time cannot
                be split between the people who worked it.
              </p>
            </div>
            <Link href="/reports/shared-jobs" className="btn-secondary shrink-0">
              View shared jobs report
            </Link>
          </div>

          {/* Job level */}
          <div className="table-container">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-900">Jobs</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Both ratings are shown; neither replaces the other. Adjusted compares like
                with like, absolute is the fixed completion table.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="table-header">
                    <th>Ticket</th>
                    <th>Technician</th>
                    <th>Class / package</th>
                    <th className="text-center">Standard</th>
                    <th className="text-center">Actual</th>
                    <th className="text-center">Variance</th>
                    <th className="text-center">Adjusted</th>
                    <th className="text-center">Absolute</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.serviceOrderId} className="border-b border-slate-50">
                      <td className="px-5 py-3">
                        <span className="text-sm font-mono text-slate-800">{r.ticketNumber ?? '--'}</span>
                        <span className="block text-[11px] text-slate-400">{r.plate ?? ''}</span>
                      </td>
                      <td className="text-sm text-slate-700">
                        {r.technicianName ?? '--'}
                        {r.isSharedOrReassigned && (
                          <span className="block text-[10px] text-amber-600">shared / reassigned</span>
                        )}
                      </td>
                      <td className="text-xs text-slate-600">
                        {r.vehicleClass ? VEHICLE_CLASS_LABEL[r.vehicleClass] ?? r.vehicleClass : '--'}
                        <span className="block text-[11px] text-slate-400">
                          {KPI_PACKAGE_LABEL[r.packageType] ?? r.packageType}
                        </span>
                      </td>
                      <td className="text-center text-sm tabular-nums">{r.standardMinutes ?? '--'}</td>
                      <td className="text-center text-sm tabular-nums">
                        {r.kpiCompletionMinutes ?? '--'}
                        {r.approvedExcludedMinutes > 0 && (
                          <span className="block text-[10px] text-slate-400">
                            −{r.approvedExcludedMinutes} excluded
                          </span>
                        )}
                      </td>
                      <td className="text-center text-sm tabular-nums">
                        {r.varianceMinutes == null
                          ? '--'
                          : r.varianceMinutes > 0
                            ? `+${r.varianceMinutes}`
                            : r.varianceMinutes}
                      </td>
                      <td className="text-center">
                        {r.adjustedTechnicianRating ? (
                          <span className={`badge text-[11px] ${KPI_RATING_BADGE[r.adjustedTechnicianRating]}`}>
                            {KPI_RATING_LABEL[r.adjustedTechnicianRating]}
                          </span>
                        ) : r.pendingBenchmarkReview ? (
                          /* Amber, not the neutral grey the other ineligible states get:
                             this one is an action someone can take, and it should not
                             sit quietly among the settled ones. */
                          <span
                            className="badge bg-amber-100 text-amber-800 text-[10px]"
                            title={r.eligibilityReason ?? ''}
                          >
                            awaiting benchmark setup
                          </span>
                        ) : (
                          <span className="badge bg-slate-100 text-slate-500 text-[10px]" title={r.eligibilityReason ?? ''}>
                            {r.eligibilityStatus.split('_').join(' ').toLowerCase()}
                          </span>
                        )}
                        {/* An excellent time with a failed quality check must never
                            read as an unqualified top result. */}
                        {r.hadRework && (
                          <span className="block text-[10px] text-red-600 mt-0.5">came back from QC</span>
                        )}
                      </td>
                      <td className="text-center">
                        {r.absoluteCompletionRating ? (
                          <span className={`badge text-[11px] ${KPI_RATING_BADGE[r.absoluteCompletionRating]}`}>
                            {KPI_RATING_LABEL[r.absoluteCompletionRating]}
                          </span>
                        ) : r.pendingBenchmarkReview ? (
                          /* Deliberately withheld, not missing. The absolute band needs
                             no benchmark, so it would otherwise show a result here for a
                             job whose unaccounted work is the likely reason it ran long. */
                          <span className="text-[10px] text-slate-400">not rated</span>
                        ) : (
                          '--'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
