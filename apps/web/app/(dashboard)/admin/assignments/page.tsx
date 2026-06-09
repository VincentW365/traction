'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { StatusBadge } from '../../../../components/status-badge';

interface AssignmentRow {
  id: string;
  serviceOrderId: string;
  technicianName: string;
  employeeCode: string;
  isPrimary: boolean;
  status: string;
  assignedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number | null;
  customerName: string;
  vehiclePlate: string;
}

function toDateString(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function AssignmentsPage() {
  const siteId = useSiteId();
  const today = toDateString(new Date());
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);

  const assignQuery = useQuery<AssignmentRow[]>({
    queryKey: ['assignment-history', siteId, startDate, endDate],
    queryFn: () => api.get(`/reports/assignment-history?siteId=${siteId}&startDate=${startDate}&endDate=${endDate}`),
  });

  const data = assignQuery.data ?? [];

  return (
    <div className="page-container">
      <PageHeader
        title="Assignments"
        subtitle="Technician job assignments"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Admin' }, { label: 'Assignments' }]}
        actions={
          <div className="flex items-center gap-2">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input-field w-auto" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="input-field w-auto" />
          </div>
        }
      />

      {assignQuery.isLoading && <LoadingState message="Loading assignments..." />}

      {data.length === 0 && assignQuery.isSuccess && (
        <EmptyState title="No assignments" description="No technician assignments for the selected period." />
      )}

      {data.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Date</th>
                <th>Technician</th>
                <th>Customer</th>
                <th>Vehicle</th>
                <th>Role</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id} className="table-row">
                  <td className="text-slate-500 whitespace-nowrap text-xs">{new Date(row.assignedAt).toLocaleDateString()}</td>
                  <td className="font-medium text-slate-900">
                    {row.technicianName}
                    <span className="text-[10px] text-slate-400 ml-1 font-mono">{row.employeeCode}</span>
                  </td>
                  <td className="text-slate-700">{row.customerName}</td>
                  <td className="font-mono text-xs text-slate-600">{row.vehiclePlate}</td>
                  <td>
                    <span className={`badge text-[10px] ${row.isPrimary ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>
                      {row.isPrimary ? 'Primary' : 'Helper'}
                    </span>
                  </td>
                  <td className="text-xs text-slate-500">{row.startedAt ? new Date(row.startedAt).toLocaleTimeString() : '--'}</td>
                  <td className="text-slate-700">{row.durationMinutes != null ? `${row.durationMinutes}m` : '--'}</td>
                  <td><StatusBadge status={row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
