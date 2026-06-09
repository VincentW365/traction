'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { StatCard } from '../../../../components/ui/stat-card';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';

interface EfficiencyRow {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  jobsCompleted: number;
  flaggedMinutes: number;
  clockMinutes: number;
  efficiencyPercent: number;
}

function toDateString(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function PerformanceDashboardPage() {
  const siteId = useSiteId();
  const today = toDateString(new Date());
  const weekAgo = toDateString(new Date(Date.now() - 7 * 86400000));
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate, setEndDate] = useState(today);

  const effQuery = useQuery<EfficiencyRow[]>({
    queryKey: ['tech-efficiency', siteId, startDate, endDate],
    queryFn: () => api.get(`/reports/technician-efficiency?siteId=${siteId}&startDate=${startDate}&endDate=${endDate}`),
  });

  const data = effQuery.data ?? [];
  const avgEff = data.length > 0 ? Math.round(data.reduce((s, r) => s + r.efficiencyPercent, 0) / data.length) : 0;
  const totalJobs = data.reduce((s, r) => s + r.jobsCompleted, 0);
  const topPerformer = data.length > 0 ? [...data].sort((a, b) => b.efficiencyPercent - a.efficiencyPercent)[0] : null;

  return (
    <div className="page-container">
      <PageHeader
        title="Technician Performance"
        subtitle="Efficiency and productivity metrics"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Admin' }, { label: 'Performance' }]}
        actions={
          <div className="flex items-center gap-2">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input-field w-auto" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="input-field w-auto" />
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard value={`${avgEff}%`} label="Avg Efficiency" color={avgEff >= 90 ? 'green' : avgEff >= 70 ? 'amber' : 'red'} />
        <StatCard value={totalJobs} label="Jobs Completed" color="blue" />
        <StatCard value={data.length} label="Active Techs" color="slate" />
        <StatCard value={topPerformer?.fullName?.split(' ')[0] ?? '--'} label="Top Performer" color="green" />
      </div>

      {effQuery.isLoading && <LoadingState message="Loading performance data..." />}

      {data.length === 0 && effQuery.isSuccess && (
        <EmptyState title="No performance data" description="No completed assignments for the selected period." />
      )}

      {data.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Technician</th>
                <th>Code</th>
                <th>Jobs</th>
                <th>Flagged (min)</th>
                <th>Clock (min)</th>
                <th>Efficiency</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.technicianId} className="table-row">
                  <td className="font-medium text-slate-900">{row.fullName}</td>
                  <td className="font-mono text-xs text-slate-500">{row.employeeCode}</td>
                  <td className="text-slate-700">{row.jobsCompleted}</td>
                  <td className="text-slate-700">{row.flaggedMinutes}</td>
                  <td className="text-slate-700">{row.clockMinutes}</td>
                  <td>
                    <span className={`badge ${row.efficiencyPercent >= 90 ? 'bg-emerald-50 text-emerald-700' : row.efficiencyPercent >= 70 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>
                      {row.efficiencyPercent}%
                    </span>
                  </td>
                  <td>
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
