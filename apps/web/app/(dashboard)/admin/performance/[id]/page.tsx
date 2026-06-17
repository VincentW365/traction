'use client';

/**
 * Technician Performance — individual view (CR-2026-044).
 * Productivity (efficiency) + quality (first-time-fix / rework) for one tech,
 * with workload split and a per-assignment history that flags jobs that came back.
 */
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { PageHeader } from '../../../../../components/ui/page-header';
import { StatCard } from '../../../../../components/ui/stat-card';
import { LoadingState } from '../../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../../components/status-badge';
import { ExportMenu } from '../../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../../lib/export';

interface TechPerformance {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  totalJobs: number;
  primaryJobs: number;
  helperJobs: number;
  totalClockMinutes: number;
  totalFlaggedMinutes: number;
  avgJobMinutes: number;
  efficiencyPercent: number;
  reworkedJobs: number;
  firstTimeFixRate: number | null;
  assignments: Array<{
    id: string;
    isPrimary: boolean;
    status: string;
    reworked: boolean;
    assignedAt: string;
    startedAt: string | null;
    endedAt: string | null;
    durationMinutes: number | null;
    customerName: string;
    vehiclePlate: string;
    services: string[];
  }>;
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
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

export default function TechnicianPerformanceDetailPage() {
  const params = useParams();
  const techId = params.id as string;
  const today = localISO(new Date());
  const [startDate, setStartDate] = useState(daysAgo(30));
  const [endDate, setEndDate] = useState(today);

  const activePreset = PRESETS.find((p) => daysAgo(p.days) === startDate && endDate === today)?.days ?? null;

  const perfQuery = useQuery<TechPerformance>({
    queryKey: ['tech-performance', techId, startDate, endDate],
    queryFn: () => api.get(`/reports/technician-performance/${techId}?startDate=${startDate}&endDate=${endDate}`),
    enabled: !!techId,
  });

  const data = perfQuery.data;

  const buildExport = (): ExportDocument | null => {
    if (!data) return null;
    return {
      title: `Technician Performance — ${data.fullName}`,
      filename: `tech-${data.employeeCode || data.technicianId}_${startDate}_${endDate}`,
      subtitle: `${data.employeeCode}`,
      meta: [
        ['Range', `${startDate} to ${endDate}`],
        ['Efficiency', `${data.efficiencyPercent}%`],
        ['First-time-fix', data.firstTimeFixRate !== null ? `${data.firstTimeFixRate}%` : '—'],
        ['Jobs completed', String(data.totalJobs)],
      ],
      sections: [
        {
          heading: 'Assignment history',
          columns: ['Date', 'Customer', 'Vehicle', 'Services', 'Role', 'Duration', 'Status', 'Came back'],
          rows: data.assignments.map((a) => [
            new Date(a.assignedAt).toLocaleDateString(),
            a.customerName || '',
            a.vehiclePlate || '',
            a.services.join(', '),
            a.isPrimary ? 'Primary' : 'Helper',
            a.durationMinutes != null ? `${a.durationMinutes}m` : '',
            a.status,
            a.reworked ? 'Yes' : '',
          ]),
        },
      ],
    };
  };

  if (perfQuery.isLoading) {
    return <div className="page-container"><LoadingState message="Loading performance..." /></div>;
  }
  if (!data) return null;

  const ftfColor = data.firstTimeFixRate === null ? 'slate' : data.firstTimeFixRate >= 95 ? 'green' : data.firstTimeFixRate >= 85 ? 'amber' : 'red';

  return (
    <div className="page-container">
      <PageHeader
        title={data.fullName}
        subtitle={data.employeeCode}
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Performance', href: '/admin/performance' },
          { label: data.fullName },
        ]}
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
            <ExportMenu build={buildExport} disabled={!data} />
          </div>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-2">
        <StatCard value={`${data.efficiencyPercent}%`} label="Efficiency" color={data.efficiencyPercent >= 90 ? 'green' : data.efficiencyPercent >= 70 ? 'amber' : 'red'} />
        <StatCard value={data.firstTimeFixRate !== null ? `${data.firstTimeFixRate}%` : '--'} label="First-Time-Fix" color={ftfColor} />
        <StatCard value={data.totalJobs} label="Jobs Completed" color="blue" />
        <StatCard value={data.avgJobMinutes > 0 ? `${data.avgJobMinutes}m` : '--'} label="Avg Job Time" color="slate" />
        <StatCard value={`${Math.round(data.totalClockMinutes / 60)}h`} label="Total Hours" color="slate" />
        <StatCard value={data.reworkedJobs} label="Came Back" color={data.reworkedJobs > 0 ? 'red' : 'slate'} />
      </div>

      <p className="text-xs text-slate-400 mb-5">
        {data.primaryJobs} primary · {data.helperJobs} helper jobs in range. First-time-fix is measured on primary jobs.
      </p>

      <div className="table-container">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Assignment History</h2>
        </div>
        {data.assignments.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">No assignments in this period.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Vehicle</th>
                <th>Services</th>
                <th>Role</th>
                <th>Duration</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.assignments.map((a) => (
                <tr key={a.id} className="table-row">
                  <td className="text-slate-500 whitespace-nowrap text-xs">
                    {new Date(a.assignedAt).toLocaleDateString()}
                  </td>
                  <td className="text-slate-700">{a.customerName}</td>
                  <td className="font-mono text-xs text-slate-600">{a.vehiclePlate}</td>
                  <td className="text-slate-600 text-xs max-w-xs truncate">{a.services.join(', ')}</td>
                  <td>
                    <span className={`badge text-[10px] ${a.isPrimary ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                      {a.isPrimary ? 'Primary' : 'Helper'}
                    </span>
                  </td>
                  <td className="text-slate-700">{a.durationMinutes != null ? `${a.durationMinutes}m` : '--'}</td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={a.status} />
                      {a.reworked && <span className="badge text-[10px] bg-red-50 text-red-600" title="This job came back for rework">came back</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
