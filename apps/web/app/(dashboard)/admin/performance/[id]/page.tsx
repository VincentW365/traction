'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { PageHeader } from '../../../../../components/ui/page-header';
import { StatCard } from '../../../../../components/ui/stat-card';
import { LoadingState } from '../../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../../components/status-badge';

interface TechPerformance {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  totalJobs: number;
  totalClockMinutes: number;
  totalFlaggedMinutes: number;
  avgJobMinutes: number;
  efficiencyPercent: number;
  assignments: Array<{
    id: string;
    isPrimary: boolean;
    status: string;
    assignedAt: string;
    startedAt: string | null;
    endedAt: string | null;
    durationMinutes: number | null;
    customerName: string;
    vehiclePlate: string;
    services: string[];
  }>;
}

function toDateString(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function TechnicianPerformanceDetailPage() {
  const params = useParams();
  const techId = params.id as string;
  const today = toDateString(new Date());
  const monthAgo = toDateString(new Date(Date.now() - 30 * 86400000));
  const [startDate, setStartDate] = useState(monthAgo);
  const [endDate, setEndDate] = useState(today);

  const perfQuery = useQuery<TechPerformance>({
    queryKey: ['tech-performance', techId, startDate, endDate],
    queryFn: () => api.get(`/reports/technician-performance/${techId}?startDate=${startDate}&endDate=${endDate}`),
    enabled: !!techId,
  });

  const data = perfQuery.data;

  if (perfQuery.isLoading) {
    return <div className="page-container"><LoadingState message="Loading performance..." /></div>;
  }

  if (!data) return null;

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
          <div className="flex items-center gap-2">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input-field w-auto" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="input-field w-auto" />
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard value={`${data.efficiencyPercent}%`} label="Efficiency" color={data.efficiencyPercent >= 90 ? 'green' : 'amber'} />
        <StatCard value={data.totalJobs} label="Jobs Completed" color="blue" />
        <StatCard value={`${data.avgJobMinutes}m`} label="Avg Job Time" color="slate" />
        <StatCard value={`${Math.round(data.totalClockMinutes / 60)}h`} label="Total Hours" color="slate" />
      </div>

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
                  <td><StatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
