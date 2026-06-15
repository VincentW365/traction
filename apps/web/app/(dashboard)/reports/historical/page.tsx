'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { StatCard } from '../../../../components/ui/stat-card';
import { LoadingState } from '../../../../components/ui/loading-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../lib/export';

const ALLOWED_ROLES = ['ADMIN', 'MANAGER'];

interface HistoricalAnalytics {
  span: { from: string | null; to: string | null };
  headline: {
    totalJobs: number;
    completed: number;
    cancelled: number;
    other: number;
    completionRate: number;
    cancellationRate: number;
  };
  totalOrders: number;
  pauseRate: number;
  reworkRate: number;
  avgDurationMinutes: number | null;
  durationSampleSize: number;
  monthlyVolume: { month: string; jobs: number }[];
  byTechnician: { technicianId: string; name: string; jobs: number }[];
}

export default function HistoricalAnalyticsPage() {
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();

  const q = useQuery({
    queryKey: ['historical-analytics', from, to],
    queryFn: () => api.get<HistoricalAnalytics>(`/reports/historical-analytics${qs ? `?${qs}` : ''}`),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Historical Analytics" subtitle="Manager report" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">You do not have permission to view this report.</p>
        </div>
      </div>
    );
  }

  const d = q.data;

  // CR-2026-016 / CR-2026-036: client-side export of the (already-fetched) historical
  // summary + tables. No backend call, no customer PII (counts + tech names only).
  const buildExport = (): ExportDocument | null => {
    if (!d) return null;
    return {
      title: 'Historical Analytics',
      filename: `historical-analytics${d.span.from ? `_${d.span.from}_to_${d.span.to}` : ''}`,
      subtitle: 'Imported job history (read-only; does not affect live operations)',
      meta: [['Span', `${d.span.from ?? '—'} → ${d.span.to ?? '—'}`], ['Imported jobs', d.headline.totalJobs.toLocaleString()]],
      sections: [
        {
          heading: 'Summary',
          columns: ['Metric', 'Value', 'Detail'],
          rows: [
            ['Total jobs', d.headline.totalJobs, ''],
            ['Completed', d.headline.completed, `${d.headline.completionRate}%`],
            ['Cancelled', d.headline.cancelled, `${d.headline.cancellationRate}%`],
            ['Pause rate', `${d.pauseRate}%`, ''],
            ['Rework rate', `${d.reworkRate}%`, ''],
            ['Avg duration (min)', d.avgDurationMinutes ?? '', `sample ${d.durationSampleSize}`],
          ],
        },
        { heading: 'Monthly volume', columns: ['Month', 'Jobs'], rows: d.monthlyVolume.map((m) => [m.month, m.jobs]) },
        { heading: 'Technician workload', columns: ['Technician', 'Jobs worked'], rows: d.byTechnician.map((t) => [t.name, t.jobs]) },
      ],
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Historical Analytics"
        subtitle="Imported job history (read-only; does not affect live operations)"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Reports', href: '/reports' },
          { label: 'Historical Analytics' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field w-auto" aria-label="From" />
            <span className="text-sm text-slate-400">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field w-auto" aria-label="To" />
            <ExportMenu build={buildExport} disabled={!d} />
          </div>
        }
      />

      {q.isLoading && <LoadingState message="Loading historical analytics..." />}

      {q.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load this report.</p>
        </div>
      )}

      {d && (
        <>
          <p className="text-xs text-slate-400 mb-4">
            Data span: {d.span.from ?? '—'} → {d.span.to ?? '—'} · {d.headline.totalJobs.toLocaleString()} imported jobs
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard value={d.headline.totalJobs.toLocaleString()} label="Total historical jobs" color="slate" />
            <StatCard
              value={`${d.headline.completionRate}%`}
              label="Completion rate"
              color="green"
              icon={<span className="text-xs font-medium text-slate-400">{d.headline.completed.toLocaleString()} closed</span>}
            />
            <StatCard
              value={`${d.headline.cancellationRate}%`}
              label="Cancellation rate"
              color="red"
              icon={<span className="text-xs font-medium text-slate-400">{d.headline.cancelled.toLocaleString()} cancelled</span>}
            />
            <StatCard value={`${d.pauseRate}%`} label="Pause rate" color="amber" />
            <StatCard value={`${d.reworkRate}%`} label="Rework rate" color="amber" />
            <StatCard
              value={d.avgDurationMinutes != null ? `${d.avgDurationMinutes} min` : '—'}
              label="Avg job duration"
              color="blue"
              icon={<span className="text-xs font-medium text-slate-400">sample: {d.durationSampleSize.toLocaleString()} jobs</span>}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            {/* Monthly volume */}
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">Monthly volume</h3>
              </div>
              <div className="card-body">
                {d.monthlyVolume.length === 0 ? (
                  <p className="text-sm text-slate-500">No jobs in this range.</p>
                ) : (
                  <div className="space-y-1.5 max-h-96 overflow-y-auto">
                    {(() => {
                      const max = Math.max(...d.monthlyVolume.map((m) => m.jobs), 1);
                      return d.monthlyVolume.map((m) => (
                        <div key={m.month} className="flex items-center gap-2 text-xs">
                          <span className="w-16 shrink-0 font-mono text-slate-500">{m.month}</span>
                          <div className="flex-1 bg-slate-100 rounded h-3">
                            <div className="bg-blue-500 h-3 rounded" style={{ width: `${(m.jobs / max) * 100}%` }} />
                          </div>
                          <span className="w-10 shrink-0 text-right font-medium text-slate-700">{m.jobs}</span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            </div>

            {/* Technician workload */}
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">Technician workload (top 15)</h3>
              </div>
              <div className="table-container">
                <table className="w-full text-sm">
                  <thead className="table-header">
                    <tr>
                      <th>Technician</th>
                      <th className="text-right">Jobs worked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.byTechnician.length === 0 ? (
                      <tr><td colSpan={2} className="text-sm text-slate-500 px-4 py-3">No assignments in this range.</td></tr>
                    ) : (
                      d.byTechnician.map((t) => (
                        <tr key={t.technicianId} className="table-row">
                          <td className="text-slate-700">{t.name}</td>
                          <td className="text-right font-medium text-slate-900">{t.jobs.toLocaleString()}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <p className="text-xs text-slate-400 mt-6">
            Note: service-family mix is not shown — the historical import did not include structured service-type
            data. Average duration is based only on jobs with a valid recorded start and end time (end after
            start); historical source timestamps are incomplete/unreliable for many jobs.
          </p>
        </>
      )}
    </div>
  );
}
