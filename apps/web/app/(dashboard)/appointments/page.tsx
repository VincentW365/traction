'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

const EDITABLE_STATUSES = ['DRAFT', 'CONFIRMED'];

export default function AppointmentsPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState(() => toDateString(new Date()));

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [editNotes, setEditNotes] = useState('');

  // Confirm cancel state
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const appointmentsQuery = useQuery({
    queryKey: ['appointments', siteId, selectedDate],
    queryFn: () => api.get<AppointmentResult[]>(`/appointments?siteId=${siteId}&date=${selectedDate}`),
  });

  const editMutation = useMutation({
    mutationFn: ({ id, scheduledStartAt, notes }: { id: string; scheduledStartAt: string; notes?: string }) =>
      api.patch(`/appointments/${id}`, { scheduledStartAt, notes: notes || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setEditingId(null);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post(`/appointments/${id}/cancel`, { reason: 'Cancelled by staff' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setCancellingId(null);
    },
  });

  function startEdit(appt: AppointmentResult) {
    const dt = new Date(appt.scheduledStartAt);
    setEditDate(toDateString(dt));
    setEditTime(`${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`);
    setEditNotes('');
    setEditingId(appt.id);
  }

  function saveEdit() {
    if (!editingId) return;
    const scheduledStartAt = new Date(`${editDate}T${editTime}:00`).toISOString();
    editMutation.mutate({ id: editingId, scheduledStartAt, notes: editNotes });
  }

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
                <th>Actions</th>
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
                  <td>
                    {EDITABLE_STATUSES.includes(appt.status) && (
                      <div className="flex items-center gap-2">
                        <button onClick={() => startEdit(appt)} className="text-xs text-blue-600 hover:underline font-medium">
                          Edit
                        </button>
                        <button onClick={() => setCancellingId(appt.id)} className="text-xs text-red-500 hover:underline">
                          Cancel
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit Appointment Modal */}
      {editingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="card w-96 p-5">
            <h3 className="text-sm font-semibold text-slate-900 mb-4">Reschedule Appointment</h3>
            <div className="space-y-3">
              <div>
                <label className="input-label">Date</label>
                <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} className="input-field" />
              </div>
              <div>
                <label className="input-label">Time</label>
                <input type="time" value={editTime} onChange={(e) => setEditTime(e.target.value)} className="input-field" min="08:00" max="17:00" step="900" />
              </div>
              <div>
                <label className="input-label">Notes</label>
                <input type="text" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} className="input-field" placeholder="Reason for change (optional)" />
              </div>
              {editMutation.isError && (
                <p className="text-xs text-red-600">{editMutation.error instanceof Error ? editMutation.error.message : 'Failed to update'}</p>
              )}
              <div className="flex items-center gap-2 pt-2">
                <button onClick={saveEdit} disabled={editMutation.isPending} className="btn-primary text-xs">
                  {editMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
                <button onClick={() => setEditingId(null)} className="btn-secondary text-xs">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Confirmation Modal */}
      {cancellingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="card w-80 p-5 text-center">
            <h3 className="text-sm font-semibold text-slate-900 mb-2">Cancel Appointment?</h3>
            <p className="text-xs text-slate-500 mb-4">This action cannot be undone.</p>
            {cancelMutation.isError && (
              <p className="text-xs text-red-600 mb-3">{cancelMutation.error instanceof Error ? cancelMutation.error.message : 'Failed'}</p>
            )}
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => cancelMutation.mutate(cancellingId)} disabled={cancelMutation.isPending} className="btn-danger text-xs">
                {cancelMutation.isPending ? 'Cancelling...' : 'Yes, Cancel'}
              </button>
              <button onClick={() => setCancellingId(null)} className="btn-secondary text-xs">No, Keep It</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
