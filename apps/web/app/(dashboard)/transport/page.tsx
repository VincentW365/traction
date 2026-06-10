'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { useAuth } from '../../../hooks/use-auth';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';
import { StatusBadge } from '../../../components/status-badge';

const TRANSPORT_ROLES = ['ADMIN', 'MANAGER', 'SERVICE_ADVISOR', 'TRANSPORT_COORDINATOR'];

interface DispatchItem {
  id: string;
  serviceVisitId: string;
  direction: 'PICKUP' | 'DROPOFF';
  status: string;
  customerName: string;
  vehiclePlate: string;
  vehicleDescription: string;
  requestedPickupAt: string | null;
  scheduledPickupAt: string | null;
  completedAt: string | null;
  driverName: string | null;
}

interface DispatchBoard {
  pending: DispatchItem[];
  scheduled: DispatchItem[];
  inProgress: DispatchItem[];
  recentlyClosed: DispatchItem[];
}

interface Driver {
  id: string;
  fullName: string;
  roleCode: string;
}

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

export default function TransportDispatchPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const allowed = TRANSPORT_ROLES.includes(user?.roleCode ?? '');

  // Inline action form: which request + which action is open.
  const [form, setForm] = useState<{ id: string; type: 'assign' | 'cancel' } | null>(null);
  const [driverUserId, setDriverUserId] = useState('');
  const [scheduledPickupAt, setScheduledPickupAt] = useState('');
  const [cancelReason, setCancelReason] = useState('');

  const boardQuery = useQuery<DispatchBoard>({
    queryKey: ['transport-dispatch', siteId],
    queryFn: () => api.get(`/transport/dispatch?siteId=${siteId}`),
    enabled: allowed && !!siteId,
    refetchInterval: 8000,
  });

  const driversQuery = useQuery<Driver[]>({
    queryKey: ['transport-drivers'],
    queryFn: () => api.get('/transport/drivers'),
    enabled: allowed && form?.type === 'assign',
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['transport-dispatch'] });
  const closeForm = () => { setForm(null); setDriverUserId(''); setScheduledPickupAt(''); setCancelReason(''); };

  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post(`/transport-requests/${id}/${action}`, body ?? {}),
    onSuccess: () => { invalidate(); closeForm(); },
  });

  const assign = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post(`/transport-requests/${id}/assign-driver`, {
        driverUserId,
        scheduledPickupAt: new Date(scheduledPickupAt).toISOString(),
      }),
    onSuccess: () => { invalidate(); closeForm(); },
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Transport Dispatch" subtitle="Vehicle pickup & drop-off coordination" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">You do not have permission to view transport dispatch.</p>
        </div>
      </div>
    );
  }

  const b = boardQuery.data;
  const total = b ? b.pending.length + b.scheduled.length + b.inProgress.length : 0;

  const actionsFor = (it: DispatchItem): Array<{ label: string; action: string; style: string }> => {
    switch (it.status) {
      case 'REQUESTED': return [{ label: 'Confirm', action: 'confirm', style: 'btn-primary' }];
      case 'CONFIRMATION_PENDING': return [{ label: 'Schedule', action: 'schedule', style: 'btn-primary' }];
      case 'SCHEDULED': return [{ label: 'Assign Driver', action: '__assign', style: 'btn-primary' }];
      case 'DRIVER_ASSIGNED': return [{ label: 'Start', action: 'start', style: 'btn-success' }];
      case 'IN_PROGRESS': return [{ label: 'Complete', action: 'complete', style: 'btn-success' }];
      default: return [];
    }
  };

  const Card = ({ it, closed }: { it: DispatchItem; closed?: boolean }) => (
    <div className="card border-l-4 border-l-blue-400 overflow-hidden">
      <div className="p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            {it.direction === 'PICKUP' ? 'Pickup' : 'Drop-off'}
          </span>
          <StatusBadge status={it.status} />
        </div>
        <p className="text-sm font-medium text-slate-900">{it.customerName}</p>
        <p className="text-xs text-slate-500">
          <span className="font-mono">{it.vehiclePlate}</span>
          {it.vehicleDescription ? <span className="text-slate-400"> · {it.vehicleDescription}</span> : null}
        </p>
        <div className="mt-2 space-y-0.5 text-xs text-slate-500">
          {it.scheduledPickupAt ? (
            <p>Scheduled: <span className="text-slate-700">{fmtTime(it.scheduledPickupAt)}</span></p>
          ) : it.requestedPickupAt ? (
            <p>Requested: <span className="text-slate-700">{fmtTime(it.requestedPickupAt)}</span></p>
          ) : null}
          {it.driverName && <p>Driver: <span className="text-slate-700">{it.driverName}</span></p>}
          {closed && it.completedAt && <p>Closed: <span className="text-slate-700">{fmtTime(it.completedAt)}</span></p>}
        </div>

        {!closed && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {actionsFor(it).map((a) => (
              <button
                key={a.action}
                onClick={() => (a.action === '__assign' ? setForm({ id: it.id, type: 'assign' }) : act.mutate({ id: it.id, action: a.action }))}
                disabled={act.isPending}
                className={`${a.style} text-xs py-1 px-2.5`}
              >
                {a.label}
              </button>
            ))}
            <button onClick={() => setForm({ id: it.id, type: 'cancel' })} className="btn-secondary text-xs py-1 px-2.5">
              Cancel
            </button>
          </div>
        )}

        {/* Assign-driver inline form */}
        {form?.id === it.id && form.type === 'assign' && (
          <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
            <div>
              <label className="input-label">Driver *</label>
              <select value={driverUserId} onChange={(e) => setDriverUserId(e.target.value)} className="input-field text-xs">
                <option value="">Select driver...</option>
                {(driversQuery.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.fullName} ({d.roleCode.replace(/_/g, ' ').toLowerCase()})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="input-label">Scheduled pickup *</label>
              <input type="datetime-local" value={scheduledPickupAt} onChange={(e) => setScheduledPickupAt(e.target.value)} className="input-field text-xs" />
            </div>
            {assign.isError && <p className="text-xs text-red-600">{assign.error instanceof Error ? assign.error.message : 'Failed'}</p>}
            <div className="flex gap-2">
              <button onClick={() => assign.mutate({ id: it.id })} disabled={!driverUserId || !scheduledPickupAt || assign.isPending} className="btn-primary text-xs">
                {assign.isPending ? 'Assigning...' : 'Assign'}
              </button>
              <button onClick={closeForm} className="btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        )}

        {/* Cancel inline form */}
        {form?.id === it.id && form.type === 'cancel' && (
          <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
            <div>
              <label className="input-label">Cancellation reason</label>
              <input type="text" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} className="input-field text-xs" placeholder="Optional" />
            </div>
            {act.isError && <p className="text-xs text-red-600">{act.error instanceof Error ? act.error.message : 'Failed'}</p>}
            <div className="flex gap-2">
              <button onClick={() => act.mutate({ id: it.id, action: 'cancel', body: { reason: cancelReason || undefined } })} disabled={act.isPending} className="btn-danger text-xs">
                {act.isPending ? 'Cancelling...' : 'Confirm Cancel'}
              </button>
              <button onClick={closeForm} className="btn-secondary text-xs">Keep</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const Section = ({ title, items, closed }: { title: string; items: DispatchItem[]; closed?: boolean }) => (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{title}</h2>
        <span className="text-xs text-slate-400">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">None.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {items.map((it) => <Card key={it.id} it={it} closed={closed} />)}
        </div>
      )}
    </section>
  );

  return (
    <div className="page-container">
      <PageHeader
        title="Transport Dispatch"
        subtitle="Vehicle pickup & drop-off coordination"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Transport Dispatch' }]}
      />

      {boardQuery.isLoading && <LoadingState message="Loading transport dispatch..." />}
      {boardQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load transport dispatch. Retrying...</p>
        </div>
      )}

      {b && total === 0 && b.recentlyClosed.length === 0 && (
        <EmptyState title="No transport requests" description="Create a transport request from a service visit to dispatch it here." />
      )}

      {b && (total > 0 || b.recentlyClosed.length > 0) && (
        <>
          <Section title="Pending" items={b.pending} />
          <Section title="Scheduled" items={b.scheduled} />
          <Section title="In Progress" items={b.inProgress} />
          {b.recentlyClosed.length > 0 && <Section title="Recently Closed" items={b.recentlyClosed} closed />}
        </>
      )}
    </div>
  );
}
