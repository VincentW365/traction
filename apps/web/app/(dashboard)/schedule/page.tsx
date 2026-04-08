'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { StatCard } from '../../../components/ui/stat-card';
import { StatusBadge } from '../../../components/status-badge';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';

interface AppointmentResult {
  id: string;
  scheduledStartAt: string;
  status: string;
  customer: { firstName: string; lastName: string };
  vehicle: { plateNumber: string; make: string | null; model: string | null };
  services: Array<{ serviceType: { name: string } }>;
}

interface ResourceItem {
  resourceId: string;
  code: string;
  name: string;
  resourceCategory: string;
  status: string;
  currentJob: {
    ticketNumber: string | null;
    customerName: string;
    vehiclePlate: string;
    startedAt: string;
  } | null;
}

const RESOURCE_BORDER: Record<string, string> = {
  AVAILABLE: 'border-l-4 border-l-emerald-500',
  OCCUPIED: 'border-l-4 border-l-amber-500',
  RESERVED: 'border-l-4 border-l-blue-500',
};

export default function SchedulePage() {
  const siteId = useSiteId();
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split('T')[0],
  );

  const { data: appointments, isLoading: apptLoading } = useQuery<AppointmentResult[]>({
    queryKey: ['schedule-appointments', siteId, selectedDate],
    queryFn: () => api.get(`/appointments?siteId=${siteId}&date=${selectedDate}`),
  });

  const { data: resourceBoard } = useQuery<{ resources: ResourceItem[] }>({
    queryKey: ['schedule-resources', siteId],
    queryFn: () => api.get(`/resources/board?siteId=${siteId}`),
    refetchInterval: 10000,
  });

  const resources = resourceBoard?.resources ?? [];
  const appts = appointments ?? [];

  const occupiedCount = resources.filter((r) => r.status === 'OCCUPIED').length;
  const availableCount = resources.filter((r) => r.status === 'AVAILABLE').length;

  return (
    <div className="page-container space-y-6">
      <PageHeader
        title="Day Schedule"
        subtitle="Appointments and resource allocation"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Schedule' },
        ]}
        actions={
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="input-field w-auto"
          />
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard value={appts.length} label="Appointments" color="blue" />
        <StatCard value={availableCount} label="Available Resources" color="green" />
        <StatCard value={occupiedCount} label="Occupied" color="amber" />
        <StatCard value={resources.length} label="Total Resources" color="slate" />
      </div>

      {/* Appointments List */}
      <section>
        <div className="card-header px-0 border-0 mb-3">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">Appointments</h2>
        </div>
        {apptLoading ? (
          <LoadingState message="Loading appointments..." />
        ) : appts.length === 0 ? (
          <EmptyState
            title="No appointments for this date"
            description="Select a different date or create a new appointment."
          />
        ) : (
          <div className="table-container">
            <table className="w-full text-sm">
              <thead className="table-header">
                <tr>
                  <th>Time</th>
                  <th>Customer</th>
                  <th>Vehicle</th>
                  <th>Services</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {appts.map((a) => (
                  <tr key={a.id} className="table-row">
                    <td className="font-medium text-slate-900 whitespace-nowrap">
                      {new Date(a.scheduledStartAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="text-slate-700">{a.customer.firstName} {a.customer.lastName}</td>
                    <td className="font-mono text-xs text-slate-700">{a.vehicle.plateNumber}</td>
                    <td className="text-slate-600 max-w-xs truncate">{a.services.map((s) => s.serviceType.name).join(', ')}</td>
                    <td><StatusBadge status={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Resource Status */}
      <section>
        <div className="card-header px-0 border-0 mb-3">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">Resource Status</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {resources.map((r) => (
            <div
              key={r.resourceId}
              className={`card p-4 ${RESOURCE_BORDER[r.status] || 'border-l-4 border-l-slate-300'}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono font-bold text-sm text-slate-900">{r.code}</span>
                <StatusBadge status={r.status} />
              </div>
              <div className="text-xs text-slate-500">{r.name}</div>
              {r.status === 'OCCUPIED' && r.currentJob && (
                <div className="mt-2 pt-2 border-t border-slate-100 text-xs text-slate-600">
                  <span className="font-medium">{r.currentJob.ticketNumber}</span>
                  {' '}&mdash;{' '}
                  {r.currentJob.customerName} ({r.currentJob.vehiclePlate})
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
