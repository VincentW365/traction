'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { StatusBadge } from '../../../components/status-badge';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { StatCard } from '../../../components/ui/stat-card';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';
import { AppointmentDetailModal } from '../../../components/appointment-detail-modal';

interface AppointmentResult {
  id: string;
  scheduledStartAt: string;
  status: string;
  customer: { firstName: string; lastName: string; phone: string };
  vehicle: { plateNumber: string; make: string | null; model: string | null; modelYear: number | null } | null;
  services: Array<{ serviceType: { name: string } }>;
}

function toDateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export default function AppointmentsPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState(() => toDateString(new Date()));
  const [openId, setOpenId] = useState<string | null>(null);

  const appointmentsQuery = useQuery({
    queryKey: ['appointments', siteId, selectedDate],
    queryFn: () => api.get<AppointmentResult[]>(`/appointments?siteId=${siteId}&date=${selectedDate}`),
  });

  const appts = appointmentsQuery.data ?? [];
  const counts = {
    total: appts.length,
    confirmed: appts.filter((a) => a.status === 'CONFIRMED').length,
    checkedIn: appts.filter((a) => ['CHECKED_IN', 'IN_PROGRESS'].includes(a.status)).length,
    completed: appts.filter((a) => ['COMPLETED', 'READY_FOR_PICKUP', 'CLOSED'].includes(a.status)).length,
  };

  const refetch = () => queryClient.invalidateQueries({ queryKey: ['appointments'] });

  return (
    <div className="page-container">
      <PageHeader
        title="Appointments"
        subtitle="View and manage scheduled appointments"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Appointments' }]}
        actions={
          <>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="input-field w-auto"
            />
            <Link href="/appointments/new" className="btn-primary">+ New Appointment</Link>
          </>
        }
      />

      {appointmentsQuery.isLoading && <LoadingState message="Loading appointments..." />}

      {appointmentsQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load appointments.</p>
        </div>
      )}

      {appointmentsQuery.data && appts.length === 0 && (
        <EmptyState
          title="No appointments for this date"
          description="Select a different date or create a new appointment."
          action={<Link href="/appointments/new" className="btn-primary text-xs">+ New Appointment</Link>}
        />
      )}

      {appts.length > 0 && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <StatCard value={counts.total} label="Total" color="blue" />
            <StatCard value={counts.confirmed} label="Confirmed" color="amber" />
            <StatCard value={counts.checkedIn} label="Checked In" color="green" />
            <StatCard value={counts.completed} label="Completed" color="green" />
          </div>

          {/* Appointment list (click a row for details + check-in) */}
          <div className="space-y-2">
            {appts.map((appt) => (
              <button
                key={appt.id}
                onClick={() => setOpenId(appt.id)}
                className="w-full text-left card hover:border-blue-300 hover:bg-blue-50/30 transition-colors"
              >
                <div className="flex items-center gap-4 px-4 py-3">
                  {/* time */}
                  <div className="w-16 shrink-0 text-center">
                    <p className="text-sm font-bold text-slate-900 leading-tight">{fmtTime(appt.scheduledStartAt)}</p>
                  </div>
                  {/* customer + vehicle */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{appt.customer.firstName} {appt.customer.lastName}</p>
                    <p className="text-xs text-slate-500 truncate">
                      {appt.customer.phone}
                      {appt.vehicle && (
                        <>
                          <span className="mx-1.5 text-slate-300">·</span>
                          <span className="font-mono">{appt.vehicle.plateNumber}</span>
                          <span className="text-slate-400"> {[appt.vehicle.modelYear, appt.vehicle.make, appt.vehicle.model].filter(Boolean).join(' ')}</span>
                        </>
                      )}
                    </p>
                  </div>
                  {/* services */}
                  <div className="hidden md:flex flex-1 min-w-0 flex-wrap gap-1 justify-start">
                    {appt.services.slice(0, 3).map((s, i) => (
                      <span key={i} className="badge bg-slate-100 text-slate-600">{s.serviceType.name}</span>
                    ))}
                    {appt.services.length > 3 && <span className="badge bg-slate-100 text-slate-400">+{appt.services.length - 3}</span>}
                  </div>
                  {/* status + chevron */}
                  <StatusBadge status={appt.status} />
                  <svg className="w-4 h-4 text-slate-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {openId && (
        <AppointmentDetailModal
          appointmentId={openId}
          onClose={() => setOpenId(null)}
          onChanged={refetch}
        />
      )}
    </div>
  );
}
