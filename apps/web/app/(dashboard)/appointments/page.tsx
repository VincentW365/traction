'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { StatusBadge } from '../../../components/status-badge';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';

interface AppointmentResult {
  id: string;
  scheduledStartAt: string;
  status: string;
  customer: { firstName: string; lastName: string; phone: string };
  vehicle: { plateNumber: string; make: string | null; model: string | null; modelYear: number | null };
  services: Array<{ serviceType: { name: string } }>;
}

function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function AppointmentsPage() {
  const siteId = useSiteId();
  const [selectedDate, setSelectedDate] = useState(() => toDateString(new Date()));

  const appointmentsQuery = useQuery({
    queryKey: ['appointments', siteId, selectedDate],
    queryFn: () => api.get<AppointmentResult[]>(`/appointments?siteId=${siteId}&date=${selectedDate}`),
  });

  return (
    <div className="page-container">
      <PageHeader
        title="Appointments"
        subtitle="View and manage scheduled appointments"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Appointments' },
        ]}
        actions={
          <>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="input-field w-auto"
            />
            <Link href="/appointments/new" className="btn-primary">
              + New Appointment
            </Link>
          </>
        }
      />

      {appointmentsQuery.isLoading && (
        <LoadingState message="Loading appointments..." />
      )}

      {appointmentsQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load appointments.</p>
        </div>
      )}

      {appointmentsQuery.data && appointmentsQuery.data.length === 0 && (
        <EmptyState
          title="No appointments for this date"
          description="Select a different date or create a new appointment."
          action={
            <Link href="/appointments/new" className="btn-primary text-xs">
              + New Appointment
            </Link>
          }
        />
      )}

      {appointmentsQuery.data && appointmentsQuery.data.length > 0 && (
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
              {appointmentsQuery.data.map((appt) => (
                <tr key={appt.id} className="table-row">
                  <td className="font-medium text-slate-900 whitespace-nowrap">
                    {new Date(appt.scheduledStartAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </td>
                  <td className="text-slate-700">
                    {appt.customer.firstName} {appt.customer.lastName}
                    <p className="text-xs text-slate-400 mt-0.5">{appt.customer.phone}</p>
                  </td>
                  <td>
                    <p className="font-mono text-xs font-medium text-slate-900">{appt.vehicle.plateNumber}</p>
                    <p className="text-xs text-slate-400">
                      {[appt.vehicle.modelYear, appt.vehicle.make, appt.vehicle.model].filter(Boolean).join(' ')}
                    </p>
                  </td>
                  <td className="text-slate-600 max-w-xs truncate">
                    {appt.services.map((s) => s.serviceType.name).join(', ')}
                  </td>
                  <td>
                    <StatusBadge status={appt.status} />
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
