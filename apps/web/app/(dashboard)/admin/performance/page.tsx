'use client';

/**
 * Technician Performance — team view (CR-2026-044).
 * Two dimensions per tech: productivity (labour efficiency = estimated ÷ actual
 * minutes) and quality (first-time-fix = share of primary jobs that did NOT come
 * back as rework). Shared date range with quick presets, sortable table, export.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { StatCard } from '../../../../components/ui/stat-card';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../lib/export';

// CR-2026-086 - the service manager's KPI benchmark. Thresholds live in the
// business rules (kpi_rating_bands); these are just the display labels.
type KpiRating = 'EXCELLENT' | 'MEETS_TARGET' | 'NEEDS_IMPROVEMENT' | 'BELOW_STANDARD';
const KPI_LABEL: Record<KpiRating, string> = {
  EXCELLENT: 'Excellent',
  MEETS_TARGET: 'Meets Target',
  NEEDS_IMPROVEMENT: 'Needs Improvement',
  BELOW_STANDARD: 'Below Standard',
};
const KPI_BADGE: Record<KpiRating, string> = {
  EXCELLENT: 'bg-emerald-50 text-emerald-700',
  MEETS_TARGET: 'bg-blue-50 text-blue-700',
  NEEDS_IMPROVEMENT: 'bg-amber-50 text-amber-700',
  BELOW_STANDARD: 'bg-red-50 text-red-700',
};

interface EfficiencyRow {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  jobsCompleted: number;
  primaryJobs: number;
  helperJobs: number;
  avgJobMinutes: number;
  flaggedMinutes: number;
  clockMinutes: number;
  efficiencyPercent: number;
  reworkedJobs: number;
  firstTimeFixRate: number | null;
  // CR-2026-086 - manager KPI band from average completion time.
  kpiRating: KpiRating | null;
}

function localISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISO(d);
}

const PRESETS: Array<{ label: string; days: number }> = [
  { label: 'Today', days: 0 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

function effColor(p: number): 'green' | 'amber' | 'red' {
  return p >= 90 ? 'green' : p >= 70 ? 'amber' : 'red';
}
function effBadge(p: number): string {
  return p >= 90 ? 'bg-emerald-50 text-emerald-700' : p >= 70 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';
}
function ftfBadge(p: number | null): string {
  if (p === null) return 'bg-slate-100 text-slate-500';
  return p >= 95 ? 'bg-emerald-50 text-emerald-700' : p >= 85 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';
}

type SortKey = 'fullName' | 'primaryJobs' | 'jobsCompleted' | 'avgJobMinutes' | 'efficiencyPercent' | 'firstTimeFixRate';

export default function PerformanceDashboardPage() {
  const siteId = useSiteId();
  const today = localISO(new Date());
  const [startDate, setStartDate] = useState(daysAgo(30));
  const [endDate, setEndDate] = useState(today);
  const [sortBy, setSortBy] = useState<SortKey>('efficiencyPercent');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const activePreset = PRESETS.find((p) => daysAgo(p.days) === startDate && endDate === today)?.days ?? null;

  const effQuery = useQuery<EfficiencyRow[]>({
    queryKey: ['tech-efficiency', siteId, startDate, endDate],
    queryFn: () => api.get(`/reports/technician-efficiency?siteId=${siteId}&startDate=${startDate}&endDate=${endDate}`),
    enabled: !!siteId,
  });

  const data = effQuery.data ?? [];

  // Team roll-ups — average only over techs who actually worked / had primary jobs,
  // so idle techs don't drag the headline numbers down.
  const worked = data.filter((r) => r.clockMinutes > 0);
  const withPrimary = data.filter((r) => r.firstTimeFixRate !== null);
  const avgEff = worked.length > 0 ? Math.round(worked.reduce((s, r) => s + r.efficiencyPercent, 0) / worked.length) : 0;
  const avgFtf = withPrimary.length > 0
    ? Math.round((withPrimary.reduce((s, r) => s + (r.firstTimeFixRate ?? 0), 0) / withPrimary.length) * 10) / 10
    : null;
  const totalJobs = data.reduce((s, r) => s + r.jobsCompleted, 0);
  const totalReworks = data.reduce((s, r) => s + r.reworkedJobs, 0);
  const activeTechs = worked.length;

  const sorted = [...data].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortBy === 'fullName') return a.fullName.localeCompare(b.fullName) * dir;
    const av = a[sortBy] ?? -1;
    const bv = b[sortBy] ?? -1;
    return ((av as number) - (bv as number)) * dir;
  });

  function toggleSort(key: SortKey) {
    if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(key); setSortDir(key === 'fullName' ? 'asc' : 'desc'); }
  }
  const Th = ({ k, label, className }: { k: SortKey; label: string; className?: string }) => (
    <th className={`cursor-pointer select-none hover:text-slate-700 ${className ?? ''}`} onClick={() => toggleSort(k)}>
      {label}{sortBy === k ? <span className="text-slate-400"> {sortDir === 'asc' ? '▲' : '▼'}</span> : null}
    </th>
  );

  const buildExport = (): ExportDocument | null => {
    if (data.length === 0) return null;
    return {
      title: 'Technician Performance',
      filename: `technician-performance_${startDate}_${endDate}`,
      subtitle: 'Productivity (efficiency) and quality (first-time-fix)',
      meta: [
        ['Range', `${startDate} to ${endDate}`],
        ['Avg efficiency', `${avgEff}%`],
        ['Avg first-time-fix', avgFtf !== null ? `${avgFtf}%` : '—'],
      ],
      sections: [
        {
          columns: ['Technician', 'Code', 'Primary', 'Helper', 'Completed', 'Avg job (min)', 'Efficiency %', 'First-time-fix %', 'KPI rating', 'Came back'],
          rows: sorted.map((r) => [
            r.fullName, r.employeeCode, r.primaryJobs, r.helperJobs, r.jobsCompleted,
            r.avgJobMinutes, r.efficiencyPercent, r.firstTimeFixRate ?? '—', r.kpiRating ? KPI_LABEL[r.kpiRating] : '—', r.reworkedJobs,
          ]),
        },
      ],
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Technician Performance"
        subtitle="Productivity and quality by technician"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Admin' }, { label: 'Performance' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => { setStartDate(daysAgo(p.days)); setEndDate(today); }}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    activePreset === p.days ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className="input-field w-auto" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" value={endDate} min={startDate} max={today} onChange={(e) => setEndDate(e.target.value)} className="input-field w-auto" />
            <ExportMenu build={buildExport} disabled={data.length === 0} />
          </div>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
        <StatCard value={`${avgEff}%`} label="Avg Efficiency" color={effColor(avgEff)} />
        <StatCard value={avgFtf !== null ? `${avgFtf}%` : '--'} label="Avg First-Time-Fix" color={avgFtf === null ? 'slate' : avgFtf >= 95 ? 'green' : avgFtf >= 85 ? 'amber' : 'red'} />
        <StatCard value={totalJobs} label="Jobs Completed" color="blue" />
        <StatCard value={totalReworks} label="Jobs Came Back" color={totalReworks > 0 ? 'red' : 'slate'} />
        <StatCard value={activeTechs} label="Active Techs" color="slate" />
      </div>

      <p className="text-xs text-slate-400 mb-5">
        Efficiency = estimated ÷ actual time worked (100% = on estimate). First-time-fix = share of primary jobs that did not return as rework.
        {' '}KPI rates average completion time: Excellent ≤ 2.0h · Meets Target 2.01–2.5h · Needs Improvement 2.51–3.0h · Below Standard &gt; 3.0h.
        {' '}Thresholds are editable in Settings under <span className="font-mono">kpi_rating_bands</span>.
      </p>

      {effQuery.isLoading && <LoadingState message="Loading performance data..." />}

      {effQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load performance data.</p>
        </div>
      )}

      {data.length === 0 && effQuery.isSuccess && (
        <EmptyState title="No performance data" description="No completed assignments for the selected period." />
      )}

      {data.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <Th k="fullName" label="Technician" />
                <th>Code</th>
                <Th k="primaryJobs" label="Jobs" className="text-center" />
                <Th k="avgJobMinutes" label="Avg job" className="text-center" />
                <Th k="efficiencyPercent" label="Efficiency" className="text-center" />
                <Th k="firstTimeFixRate" label="First-time-fix" className="text-center" />
                <th className="text-center">KPI</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.technicianId} className="table-row">
                  <td className="font-medium text-slate-900">{row.fullName}</td>
                  <td className="font-mono text-xs text-slate-500">{row.employeeCode}</td>
                  <td className="text-center text-slate-700">
                    {row.primaryJobs + row.helperJobs}
                    <span className="block text-[10px] text-slate-400">{row.primaryJobs} primary · {row.helperJobs} helper</span>
                  </td>
                  <td className="text-center text-slate-700 tabular-nums">{row.avgJobMinutes > 0 ? `${row.avgJobMinutes}m` : '—'}</td>
                  <td className="text-center">
                    <span className={`badge ${effBadge(row.efficiencyPercent)}`}>{row.efficiencyPercent}%</span>
                  </td>
                  <td className="text-center">
                    <span className={`badge ${ftfBadge(row.firstTimeFixRate)}`}>{row.firstTimeFixRate !== null ? `${row.firstTimeFixRate}%` : '—'}</span>
                    {row.reworkedJobs > 0 && <span className="block text-[10px] text-red-500 mt-0.5">{row.reworkedJobs} came back</span>}
                  </td>
                  {/* CR-2026-086 — the manager's KPI band, rated on average completion time. */}
                  <td className="text-center">
                    {row.kpiRating ? (
                      <span className={`badge ${KPI_BADGE[row.kpiRating]}`}>{KPI_LABEL[row.kpiRating]}</span>
                    ) : (
                      <span className="badge bg-slate-100 text-slate-500">—</span>
                    )}
                  </td>
                  <td className="text-right">
                    <Link href={`/admin/performance/${row.technicianId}`} className="text-xs text-blue-600 hover:underline font-medium">
                      Detail
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
