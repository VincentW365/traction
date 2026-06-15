'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { StatCard } from '../../../../components/ui/stat-card';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../lib/export';

const ALLOWED_ROLES = ['ADMIN', 'MANAGER'];
const CATEGORIES = ['SERVICE', 'ENGINE & OTHER', 'FULL SERVICE', 'TRANSMISSIONS', 'FUEL FILTERS', 'RADIATOR', 'ENGINE MOUNTS', 'SUSPENSION', 'BRAKES', 'STEERING', 'DRIVETRAIN', 'LIGHTING & BODY', 'CAR CARE'];

interface Job { name: string; category: string; volume: number; basePrice: number | null; estValue: number | null }
interface ServiceMix {
  mode: 'auto' | 'suggested';
  span: { from: string | null; to: string | null };
  valueNote: string;
  historical: {
    categorySummary: { category: string; jobs: number; auto: number; review: number; estValueAuto: number; missingPriceMappings: number }[];
    timeline: {
      months: string[];
      overallMonthly: { month: string; jobs: number; rolling3: number }[];
      topGrowing: { category: string; recent: number; prior: number; delta: number }[];
      topShrinking: { category: string; recent: number; prior: number; delta: number }[];
    };
    jobs: { topByVolume: Job[]; topByValue: Job[]; highVolumeLowValue: Job[]; lowVolumeHighValue: Job[]; servicesMissingPrice: Job[] };
    operationalByCategory: { category: string; orders: number; avgDurationMinutes: number | null; durationSampleSize: number; completed: number; cancelled: number; pauseRate: number; reworkRate: number }[];
    technicianMixByCategory: { category: string; technicians: { name: string; jobs: number }[] }[];
    coverage: { totalHistoricalOrders: number; autoMappedOrders: number; anyMappedOrders: number; unmappedOrders: number; analyticsReadyPct: number; potentialAfterReviewPct: number; unmappedPct: number; autoMappings: number; suggestedReviewMappings: number; reviewBacklogByCategory: { category: string; review: number }[] };
  };
  live: { serviceMixByFamily: { family: string; items: number }[]; hasLiveItems: boolean };
}

const money = (n: number | null) => (n == null ? '—' : `~$${Math.round(n).toLocaleString()}`);

function Bars({ rows, max }: { rows: { label: string; value: number }[]; max: number }) {
  const m = Math.max(max, 1);
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 font-mono text-slate-500 truncate">{r.label}</span>
          <div className="flex-1 bg-slate-100 rounded h-3"><div className="bg-blue-500 h-3 rounded" style={{ width: `${(r.value / m) * 100}%` }} /></div>
          <span className="w-12 shrink-0 text-right font-medium text-slate-700">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function JobTable({ title, jobs, showValue = true }: { title: string; jobs: Job[]; showValue?: boolean }) {
  return (
    <div className="card">
      <div className="card-header"><h3 className="text-sm font-semibold text-slate-900">{title}</h3></div>
      <div className="table-container">
        <table className="w-full text-sm">
          <thead className="table-header"><tr><th>Service</th><th>Category</th><th className="text-right">Vol</th>{showValue && <th className="text-right">Est. value</th>}</tr></thead>
          <tbody>
            {jobs.length === 0 ? <tr><td colSpan={showValue ? 4 : 3} className="text-sm text-slate-500 px-4 py-3">None.</td></tr> :
              jobs.map((j, i) => (
                <tr key={i} className="table-row">
                  <td className="text-slate-700">{j.name}</td>
                  <td className="text-slate-500 text-xs">{j.category}</td>
                  <td className="text-right font-medium">{j.volume}</td>
                  {showValue && <td className="text-right text-slate-600">{money(j.estValue)}{j.basePrice == null ? ' (no price)' : ''}</td>}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ServiceMixPage() {
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [mode, setMode] = useState<'auto' | 'suggested'>('auto');

  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (category) qs.set('category', category);
  qs.set('mode', mode);

  const q = useQuery({
    queryKey: ['service-mix', from, to, category, mode],
    queryFn: () => api.get<ServiceMix>(`/reports/service-mix?${qs.toString()}`),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Service Mix / Job Trends" subtitle="Manager report" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50"><p className="text-sm text-amber-800">You do not have permission to view this report.</p></div>
      </div>
    );
  }

  const d = q.data;
  const h = d?.historical;

  // Shared report context for every export (no PII — categories/counts/values/tech names only).
  const reportMeta = (): Array<[string, string]> => [
    ['Mode', d?.mode === 'suggested' ? 'incl. suggested (fuzzy)' : 'confirmed/auto only'],
    ['Span', `${d?.span.from ?? '—'} → ${d?.span.to ?? '—'}`],
    ['Note', 'Estimated catalog value, not invoice revenue'],
  ];

  const catSection = () => ({
    heading: 'Category summary',
    columns: ['Category', 'Jobs', 'Auto', 'Review', 'Est. value (auto)', 'Missing-price mappings'],
    rows: h!.categorySummary.map((c) => [c.category, c.jobs, c.auto, c.review, Math.round(c.estValueAuto), c.missingPriceMappings]),
  });
  const trendSections = () => [
    { heading: 'Monthly volume', columns: ['Month', 'Jobs', 'Rolling 3-mo avg'], rows: h!.timeline.overallMonthly.map((m) => [m.month, m.jobs, m.rolling3]) },
    { heading: 'Top growing (recent vs prior 3 mo)', columns: ['Category', 'Recent', 'Prior', 'Delta'], rows: h!.timeline.topGrowing.map((g) => [g.category, g.recent, g.prior, g.delta]) },
    { heading: 'Top shrinking', columns: ['Category', 'Recent', 'Prior', 'Delta'], rows: h!.timeline.topShrinking.map((g) => [g.category, g.recent, g.prior, g.delta]) },
  ];
  const reviewSections = () => {
    const c = h!.coverage;
    return [
      { heading: 'Coverage', columns: ['Metric', 'Value'], rows: [
        ['Total historical orders', c.totalHistoricalOrders], ['Auto-mapped orders', c.autoMappedOrders], ['Any-mapped orders', c.anyMappedOrders],
        ['Unmapped orders', c.unmappedOrders], ['Analytics-ready %', c.analyticsReadyPct], ['Potential after review %', c.potentialAfterReviewPct],
        ['Unmapped %', c.unmappedPct], ['Suggested-review mappings', c.suggestedReviewMappings],
      ] as (string | number)[][] },
      { heading: 'Review backlog by category', columns: ['Category', 'Needs review'], rows: c.reviewBacklogByCategory.map((r) => [r.category, r.review]) },
    ];
  };
  const operationalSection = () => ({
    heading: 'Operational metrics by category',
    columns: ['Category', 'Orders', 'Avg dur (min)', 'Sample', 'Pause %', 'Rework %', 'Closed', 'Cancelled'],
    rows: h!.operationalByCategory.map((o) => [o.category, o.orders, o.avgDurationMinutes ?? '—', o.durationSampleSize, o.pauseRate, o.reworkRate, o.completed, o.cancelled]),
  });
  const techMixSection = () => ({
    heading: 'Technician workload mix by category (top 3)',
    columns: ['Category', 'Technician', 'Jobs'],
    rows: h!.technicianMixByCategory.flatMap((t) => t.technicians.map((x) => [t.category, x.name, x.jobs] as (string | number)[])),
  });

  const buildCategoryExport = (): ExportDocument | null => (!h || !d ? null : { title: 'Service Mix — Category Summary', filename: 'service-mix-categories', meta: reportMeta(), sections: [catSection()] });
  const buildTrendExport = (): ExportDocument | null => (!h || !d ? null : { title: 'Service Mix — Job Trends', filename: 'service-mix-trends', meta: reportMeta(), sections: trendSections() });
  const buildReviewExport = (): ExportDocument | null => (!h || !d ? null : { title: 'Service Mix — Unmapped / Review Backlog', filename: 'service-mix-review-backlog', meta: reportMeta(), sections: reviewSections() });
  const buildFullExport = (): ExportDocument | null =>
    !h || !d
      ? null
      : {
          title: 'Service Mix / Job Trends',
          filename: 'service-mix-report',
          subtitle: 'Imported job categories & trends (read-only; estimated catalog value, not invoice revenue)',
          meta: reportMeta(),
          sections: [catSection(), ...trendSections(), operationalSection(), techMixSection(), ...reviewSections()],
        };

  return (
    <div className="page-container">
      <PageHeader
        title="Service Mix / Job Trends"
        subtitle="Imported job categories & trends (read-only; estimated catalog value, not invoice revenue)"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: 'Service Mix' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field w-auto" aria-label="From" />
            <span className="text-sm text-slate-400">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field w-auto" aria-label="To" />
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field w-auto" aria-label="Category">
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'auto' | 'suggested')} className="input-field w-auto" aria-label="Confidence mode">
              <option value="auto">Confirmed/auto only</option>
              <option value="suggested">Include suggested (fuzzy)</option>
            </select>
            <ExportMenu build={buildFullExport} disabled={!h} label="Export all" />
          </div>
        }
      />

      {q.isLoading && <LoadingState message="Loading service mix..." />}
      {q.isError && <div className="card p-6 text-center border-red-200 bg-red-50"><p className="text-sm text-red-700">Failed to load this report.</p></div>}

      {d && h && (
        <>
          <p className="text-xs text-slate-400 mb-3">
            Span {d.span.from ?? '—'} → {d.span.to ?? '—'} · mode: <b>{d.mode === 'suggested' ? 'incl. suggested (fuzzy, low-confidence)' : 'confirmed/auto only'}</b> · {d.valueNote}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard value={`${h.coverage.analyticsReadyPct}%`} label="Analytics-ready (auto)" color="green" icon={<span className="text-xs text-slate-400">{h.coverage.autoMappedOrders}/{h.coverage.totalHistoricalOrders} orders</span>} />
            <StatCard value={`${h.coverage.potentialAfterReviewPct}%`} label="Potential after review" color="blue" icon={<span className="text-xs text-slate-400">{h.coverage.suggestedReviewMappings} to review</span>} />
            <StatCard value={`${h.coverage.unmappedPct}%`} label="Unmapped" color="amber" icon={<span className="text-xs text-slate-400">{h.coverage.unmappedOrders} orders</span>} />
            <StatCard value={money(h.categorySummary.reduce((s, c) => s + c.estValueAuto, 0))} label="Est. catalog value (auto)" color="slate" icon={<span className="text-[10px] text-slate-400">estimated, not invoice</span>} />
          </div>

          {/* Category summary */}
          <div className="card mt-6">
            <div className="card-header flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Category summary</h2>
              <ExportMenu build={buildCategoryExport} disabled={!h} />
            </div>
            <div className="table-container">
              <table className="w-full text-sm">
                <thead className="table-header"><tr><th>Category</th><th className="text-right">Jobs</th><th className="text-right">Auto</th><th className="text-right">Review</th><th className="text-right">Est. value (auto)</th><th className="text-right">No price</th></tr></thead>
                <tbody>
                  {h.categorySummary.map((c) => (
                    <tr key={c.category} className="table-row">
                      <td className="text-slate-700">{c.category}</td>
                      <td className="text-right font-medium">{c.jobs}</td>
                      <td className="text-right text-emerald-700">{c.auto}</td>
                      <td className="text-right text-amber-700">{c.review}</td>
                      <td className="text-right text-slate-600">{money(c.estValueAuto)}</td>
                      <td className="text-right text-slate-400">{c.missingPriceMappings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Timeline + growth */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            <div className="card">
              <div className="card-header flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">Monthly volume (rolling 3-mo)</h3>
                <ExportMenu build={buildTrendExport} disabled={!h} />
              </div>
              <div className="card-body">
                {h.timeline.overallMonthly.length === 0 ? <p className="text-sm text-slate-500">No data in range.</p> :
                  <Bars rows={h.timeline.overallMonthly.slice(-18).map((m) => ({ label: m.month, value: m.jobs }))} max={Math.max(...h.timeline.overallMonthly.map((m) => m.jobs))} />}
              </div>
            </div>
            <div className="card">
              <div className="card-header"><h3 className="text-sm font-semibold text-slate-900">Growing / shrinking categories</h3><span className="text-[10px] text-slate-400">recent 3 mo vs prior 3 mo</span></div>
              <div className="card-body grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-semibold text-emerald-700 mb-1">Growing</p>
                  {h.timeline.topGrowing.map((g) => <p key={g.category} className="text-xs text-slate-600">{g.category} <span className="text-emerald-600">+{g.delta}</span></p>)}
                  {h.timeline.topGrowing.length === 0 && <p className="text-xs text-slate-400">None.</p>}
                </div>
                <div>
                  <p className="text-xs font-semibold text-red-700 mb-1">Shrinking</p>
                  {h.timeline.topShrinking.map((g) => <p key={g.category} className="text-xs text-slate-600">{g.category} <span className="text-red-600">{g.delta}</span></p>)}
                  {h.timeline.topShrinking.length === 0 && <p className="text-xs text-slate-400">None.</p>}
                </div>
              </div>
            </div>
          </div>

          {/* Job-level */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            <JobTable title="Top jobs by volume" jobs={h.jobs.topByVolume} />
            <JobTable title="Top jobs by estimated value" jobs={h.jobs.topByValue} />
            <JobTable title="High volume / low value" jobs={h.jobs.highVolumeLowValue} />
            <JobTable title="Low volume / high value" jobs={h.jobs.lowVolumeHighValue} />
          </div>
          {h.jobs.servicesMissingPrice.length > 0 && (
            <div className="mt-6"><JobTable title="Services missing a catalog price" jobs={h.jobs.servicesMissingPrice} showValue={false} /></div>
          )}

          {/* Operational */}
          <div className="card mt-6">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Operational metrics by category</h2></div>
            <div className="table-container">
              <table className="w-full text-sm">
                <thead className="table-header"><tr><th>Category</th><th className="text-right">Orders</th><th className="text-right">Avg dur (min)</th><th className="text-right">Pause %</th><th className="text-right">Rework %</th><th className="text-right">Closed</th><th className="text-right">Cancelled</th></tr></thead>
                <tbody>
                  {h.operationalByCategory.map((o) => (
                    <tr key={o.category} className="table-row">
                      <td className="text-slate-700">{o.category}</td>
                      <td className="text-right">{o.orders}</td>
                      <td className="text-right">{o.avgDurationMinutes ?? '—'}<span className="text-[10px] text-slate-400"> (n={o.durationSampleSize})</span></td>
                      <td className="text-right text-amber-700">{o.pauseRate}%</td>
                      <td className="text-right text-amber-700">{o.reworkRate}%</td>
                      <td className="text-right text-emerald-700">{o.completed}</td>
                      <td className="text-right text-red-600">{o.cancelled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Technician mix */}
          <div className="card mt-6">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Technician workload mix by category</h2><span className="text-[10px] text-slate-400">top 3 per category</span></div>
            <div className="card-body grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {h.technicianMixByCategory.map((t) => (
                <div key={t.category} className="border border-slate-200 rounded-md p-3">
                  <p className="text-xs font-semibold text-slate-700 mb-1">{t.category}</p>
                  {t.technicians.map((x) => <p key={x.name} className="text-xs text-slate-500">{x.name} <span className="text-slate-400">· {x.jobs}</span></p>)}
                </div>
              ))}
            </div>
          </div>

          {/* Review backlog */}
          <div className="card mt-6">
            <div className="card-header flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Unmapped & review backlog</h2>
              <ExportMenu build={buildReviewExport} disabled={!h} />
            </div>
            <div className="card-body">
              <p className="text-xs text-slate-500 mb-2">
                {h.coverage.autoMappedOrders} auto-ready · {h.coverage.suggestedReviewMappings} suggested mappings to review · {h.coverage.unmappedOrders} orders unmapped ({h.coverage.unmappedPct}%).
                Unmapped raw text is not stored (PII-safe); recurring patterns live in the P1b dry-run report.
              </p>
              <div className="flex flex-wrap gap-2">
                {h.coverage.reviewBacklogByCategory.map((r) => (
                  <span key={r.category} className="badge bg-amber-50 text-amber-700 border border-amber-200">{r.category}: {r.review}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Live */}
          <div className="card mt-6">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Live service mix (current jobs)</h2></div>
            <div className="card-body">
              {!d.live.hasLiveItems ? (
                <EmptyState title="No live structured jobs yet" description="Live category analytics appear here once current jobs accrue structured service items (via ServiceType.family)." />
              ) : (
                <Bars rows={d.live.serviceMixByFamily.map((f) => ({ label: f.family, value: f.items }))} max={Math.max(...d.live.serviceMixByFamily.map((f) => f.items))} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
