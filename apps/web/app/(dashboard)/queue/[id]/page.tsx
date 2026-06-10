'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../components/status-badge';
import { useSiteId } from '../../../../hooks/use-site';
import { useAuth } from '../../../../hooks/use-auth';
import { PAUSE_REASONS, REWORK_REASONS } from '../../../../lib/service-order-actions';

/* ---------- Types ---------- */

interface TicketDetail {
  id: string;
  ticketNumber: string;
  checkinSequence: number;
  queueRank: number | null;
  displayStatus: string;
  blockedReason: string | null;
  readyForDispatch: boolean;
  overrideActive: boolean;
  overrideReasonCode: string | null;
  generatedAt: string;
  lastRankedAt: string | null;
  serviceVisit: {
    id: string;
    sourceType: string;
    status: string;
    arrivalAt: string | null;
    checkedInAt: string | null;
    mileageIn: number | null;
    oilBrandRequested: string | null;
    oilGradeRequested: string | null;
    partsReadiness: string;
    customer: { id: string; firstName: string; lastName: string; phone: string };
    vehicle: { id: string; plateNumber: string; make: string | null; model: string | null };
    appointment: {
      id: string;
      scheduledStartAt: string;
      services: Array<{ serviceType: { name: string; code: string } }>;
    } | null;
  };
  queueEvents: Array<{
    id: string;
    eventType: string;
    positionBefore: number | null;
    positionAfter: number | null;
    reasonCode: string | null;
    createdAt: string;
  }>;
}

interface ServiceOrder {
  id: string;
  status: string;
  paymentStatus: string;
  notes: string | null;
  promisedCompletionAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  items: Array<{
    id: string;
    serviceType: { name: string; code: string };
    estimateMinutes: number | null;
    actualMinutes: number | null;
    status: string;
  }>;
  assignments: Array<{
    id: string;
    isPrimary: boolean;
    status: string;
    technician: { id: string; userAccount: { fullName: string }; employeeCode: string };
    bay: { id: string; code: string; bayType: string } | null;
  }>;
}

interface TechOption {
  id: string;
  employeeCode: string;
  userAccount: { fullName: string };
}

const OVERRIDE_REASONS = ['CUSTOMER_REQUEST', 'MANAGER_ESCALATION', 'VIP', 'URGENT_REPAIR', 'OTHER'];
const DISPATCHABLE_STATUSES = ['WAITING', 'ISSUED', 'PENDING_RANK', 'BLOCKED'];

// CR-2026-018 (P3) — no-show / abandon. Mirrors the backend QUEUE_ABANDON grant
// (FRONT_DESK + SERVICE_ADVISOR + MANAGER + ADMIN) and the abandonable-status set.
const ABANDON_REASONS = ['NO_SHOW', 'LEFT_BEFORE_SERVICE', 'CUSTOMER_CANCELLED_ONSITE', 'UNREACHABLE', 'OTHER'];
const ABANDON_ROLES = ['ADMIN', 'MANAGER', 'SERVICE_ADVISOR', 'FRONT_DESK'];
const ABANDONABLE_VISIT_STATUSES = ['CREATED', 'ARRIVED', 'CHECKED_IN', 'QUEUED', 'CALLED', 'IN_SERVICE', 'WAITING_PARTS'];

// P2 — transport request from visit context.
const TRANSPORT_ROLES = ['ADMIN', 'MANAGER', 'SERVICE_ADVISOR', 'TRANSPORT_COORDINATOR'];
const TRANSPORT_ACTIVE = ['REQUESTED', 'CONFIRMATION_PENDING', 'SCHEDULED', 'DRIVER_ASSIGNED', 'IN_PROGRESS'];

interface TransportRequestRow {
  id: string;
  direction: 'PICKUP' | 'DROPOFF';
  status: string;
  requestedPickupAt: string | null;
  scheduledPickupAt: string | null;
  driver: { id: string; fullName: string } | null;
}

const ORDER_ACTIONS: Record<string, Array<{ label: string; toStatus: string; style: string }>> = {
  DRAFT: [{ label: 'Approve', toStatus: 'APPROVED', style: 'btn-primary' }],
  APPROVED: [],
  ASSIGNED: [{ label: 'Start Work', toStatus: 'IN_PROGRESS', style: 'btn-success' }],
  IN_PROGRESS: [
    { label: 'Send to QC', toStatus: 'QC', style: 'btn-primary' },
    { label: 'Wait Parts', toStatus: 'WAITING_PARTS', style: 'btn-secondary' },
    { label: 'Wait Customer', toStatus: 'WAITING_CUSTOMER', style: 'btn-secondary' },
  ],
  WAITING_PARTS: [{ label: 'Resume Work', toStatus: 'IN_PROGRESS', style: 'btn-success' }],
  WAITING_CUSTOMER: [{ label: 'Resume Work', toStatus: 'IN_PROGRESS', style: 'btn-success' }],
  QC: [{ label: 'Ready to Invoice', toStatus: 'READY_TO_INVOICE', style: 'btn-primary' }],
  READY_TO_INVOICE: [{ label: 'Close Order', toStatus: 'CLOSED', style: 'btn-success' }],
};

/* ---------- Component ---------- */

export default function QueueTicketDetailPage() {
  const params = useParams();
  const ticketId = params.id as string;
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Override form state
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [ovrPosition, setOvrPosition] = useState(1);
  const [ovrReason, setOvrReason] = useState('CUSTOMER_REQUEST');
  const [ovrNotes, setOvrNotes] = useState('');
  const [clearReason, setClearReason] = useState('');

  // Assign form state
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [assignTechId, setAssignTechId] = useState('');
  const [assignBayId, setAssignBayId] = useState('');

  // Pause / rework form state (CR-2026-011) — keyed by order id
  const [pauseFormOrderId, setPauseFormOrderId] = useState<string | null>(null);
  const [pauseReason, setPauseReason] = useState<string>(PAUSE_REASONS[0].value);
  const [pauseNotes, setPauseNotes] = useState('');
  const [reworkFormOrderId, setReworkFormOrderId] = useState<string | null>(null);
  const [reworkReason, setReworkReason] = useState<string>(REWORK_REASONS[0].value);
  const [reworkDesc, setReworkDesc] = useState('');

  // Completion form state
  const [showCompletion, setShowCompletion] = useState(false);
  const [mileageOut, setMileageOut] = useState('');
  const [oilBrandInstalled, setOilBrandInstalled] = useState('');
  const [oilGradeInstalled, setOilGradeInstalled] = useState('');
  // P4(c) payment-release manager exception (GOV-005)
  const [paymentOverride, setPaymentOverride] = useState(false);
  const [paymentOverrideReason, setPaymentOverrideReason] = useState('');

  // Abandon / no-show form state (CR-2026-018, P3)
  const [showAbandonForm, setShowAbandonForm] = useState(false);
  const [abandonReason, setAbandonReason] = useState(ABANDON_REASONS[0]);
  const [abandonNotes, setAbandonNotes] = useState('');

  // Transport request form state (P2)
  const canTransport = TRANSPORT_ROLES.includes(user?.roleCode ?? '');
  const [showTransportForm, setShowTransportForm] = useState(false);
  const [transportDirection, setTransportDirection] = useState<'DROPOFF' | 'PICKUP'>('DROPOFF');
  const [transportPickupAt, setTransportPickupAt] = useState('');
  const [transportNotes, setTransportNotes] = useState('');

  // --- Queries ---
  const { data: ticket, isLoading, error } = useQuery<TicketDetail>({
    queryKey: ['queue-ticket', ticketId],
    queryFn: () => api.get(`/queue-tickets/${ticketId}`),
    enabled: !!ticketId,
    refetchInterval: 10000,
  });

  const ordersQuery = useQuery<ServiceOrder[]>({
    queryKey: ['service-orders', ticket?.serviceVisit?.id],
    queryFn: () => api.get(`/service-orders/by-visit/${ticket!.serviceVisit.id}`),
    enabled: !!ticket?.serviceVisit?.id,
    refetchInterval: 10000,
  });

  const transportQuery = useQuery<TransportRequestRow[]>({
    queryKey: ['transport-by-visit', ticket?.serviceVisit?.id],
    queryFn: () => api.get(`/transport-requests/by-visit/${ticket!.serviceVisit.id}`),
    enabled: canTransport && !!ticket?.serviceVisit?.id,
    refetchInterval: 10000,
  });

  const techsQuery = useQuery<TechOption[]>({
    queryKey: ['technicians-list', siteId],
    queryFn: () => api.get(`/technicians?siteId=${siteId}`),
    enabled: !!assigningOrderId,
  });

  // --- Mutations ---
  const applyOverride = useMutation({
    mutationFn: () => api.post(`/queue-tickets/${ticketId}/override`, {
      reasonCode: ovrReason,
      targetPosition: ovrPosition,
      notes: ovrNotes || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue-ticket', ticketId] });
      setShowOverrideForm(false);
      setOvrNotes('');
    },
  });

  const clearOverride = useMutation({
    mutationFn: () => api.post(`/queue-tickets/${ticketId}/clear-override`, { reason: clearReason || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue-ticket', ticketId] });
      setClearReason('');
    },
  });

  const changeOrderStatus = useMutation({
    mutationFn: ({ orderId, toStatus }: { orderId: string; toStatus: string }) =>
      api.post(`/service-orders/${orderId}/status`, { toStatus }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      queryClient.invalidateQueries({ queryKey: ['queue-ticket', ticketId] });
    },
  });

  const approveOrder = useMutation({
    mutationFn: (orderId: string) => api.post(`/service-orders/${orderId}/approve`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service-orders'] }),
  });

  // CR-2026-011 — dedicated pause/resume/rework endpoints (recording-only; NOT /status)
  const invalidateOrders = () => {
    queryClient.invalidateQueries({ queryKey: ['service-orders'] });
    queryClient.invalidateQueries({ queryKey: ['queue-ticket', ticketId] });
  };
  const pauseOrder = useMutation({
    mutationFn: ({ orderId }: { orderId: string }) =>
      api.post(`/service-orders/${orderId}/pause`, { reasonCode: pauseReason, notes: pauseNotes || undefined }),
    onSuccess: () => {
      invalidateOrders();
      setPauseFormOrderId(null);
      setPauseNotes('');
      setPauseReason(PAUSE_REASONS[0].value);
    },
  });
  const resumeOrder = useMutation({
    mutationFn: ({ orderId }: { orderId: string }) =>
      api.post(`/service-orders/${orderId}/resume`, {}),
    onSuccess: invalidateOrders,
  });
  const reworkOrder = useMutation({
    mutationFn: ({ orderId }: { orderId: string }) =>
      api.post(`/service-orders/${orderId}/rework`, { reasonCode: reworkReason, description: reworkDesc || undefined }),
    onSuccess: () => {
      invalidateOrders();
      setReworkFormOrderId(null);
      setReworkDesc('');
      setReworkReason(REWORK_REASONS[0].value);
    },
  });

  const assignOrder = useMutation({
    mutationFn: ({ orderId }: { orderId: string }) =>
      api.post(`/service-orders/${orderId}/assign`, {
        technicianId: assignTechId,
        bayId: assignBayId || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      setAssigningOrderId(null);
      setAssignTechId('');
      setAssignBayId('');
    },
  });

  const completeVisit = useMutation({
    mutationFn: () => api.patch(`/service-visits/${ticket!.serviceVisit.id}/completion`, {
      mileageOut: mileageOut ? parseInt(mileageOut, 10) : undefined,
      oilBrandInstalled: oilBrandInstalled || undefined,
      oilGradeInstalled: oilGradeInstalled || undefined,
      paymentReleaseOverride: paymentOverride || undefined,
      paymentReleaseOverrideReason: paymentOverride ? (paymentOverrideReason || undefined) : undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue-ticket', ticketId] });
      setShowCompletion(false);
    },
  });

  // CR-2026-018 (P3) — mark no-show / abandoned; drops the visit off the board.
  const abandonVisit = useMutation({
    mutationFn: () => api.post(`/queue-tickets/${ticketId}/abandon`, {
      reasonCode: abandonReason,
      notes: abandonNotes || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue-ticket', ticketId] });
      queryClient.invalidateQueries({ queryKey: ['queue-board'] });
      setShowAbandonForm(false);
      setAbandonNotes('');
    },
  });

  // P2 — create a transport request for this visit.
  const createTransport = useMutation({
    mutationFn: () => api.post('/transport-requests', {
      serviceVisitId: ticket!.serviceVisit.id,
      direction: transportDirection,
      requestedPickupAt: transportPickupAt ? new Date(transportPickupAt).toISOString() : undefined,
      notes: transportNotes || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transport-by-visit', ticket?.serviceVisit?.id] });
      setShowTransportForm(false);
      setTransportNotes('');
      setTransportPickupAt('');
    },
  });

  // --- Render ---
  if (isLoading) {
    return (
      <div className="page-container">
        <LoadingState message="Loading ticket detail..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <PageHeader title="Queue Ticket" breadcrumbs={[{ label: 'Queue Board', href: '/queue' }, { label: 'Error' }]} />
        <div className="card">
          <div className="card-body">
            <div className="flex items-center gap-3 text-red-700">
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm">{(error as Error).message}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!ticket) return null;

  const sv = ticket.serviceVisit;
  const services = sv.appointment?.services?.map((s) => s.serviceType.name).join(', ') ?? 'Walk-in service';
  const orders = ordersQuery.data ?? [];
  const canOverride = !ticket.overrideActive && DISPATCHABLE_STATUSES.includes(ticket.displayStatus);
  const showCompletionSection = sv.status === 'READY_FOR_PICKUP' || sv.status === 'QC';
  // P4(c): vehicle-release payment gate (GOV-005). Cleared = PAID/ON_ACCOUNT/WAIVED.
  const PAYMENT_CLEARED = ['PAID', 'ON_ACCOUNT', 'WAIVED'];
  const unpaidOrders = orders.filter((o) => !PAYMENT_CLEARED.includes(o.paymentStatus));
  const paymentBlocked = unpaidOrders.length > 0;
  const isManager = ['ADMIN', 'MANAGER'].includes(user?.roleCode ?? '');
  const releaseDisabled =
    completeVisit.isPending ||
    (!!mileageOut && sv.mileageIn != null && parseInt(mileageOut, 10) < sv.mileageIn) ||
    (paymentBlocked && (!isManager || !paymentOverride || !paymentOverrideReason.trim()));
  const canAbandon =
    ABANDON_ROLES.includes(user?.roleCode ?? '') &&
    sv.sourceType !== 'HISTORICAL_IMPORT' &&
    ABANDONABLE_VISIT_STATUSES.includes(sv.status) &&
    !['COMPLETED', 'CANCELLED'].includes(ticket.displayStatus);
  const transportRequests = transportQuery.data ?? [];
  const hasActiveTransport = transportRequests.some((t) => TRANSPORT_ACTIVE.includes(t.status));

  return (
    <div className="page-container">
      <PageHeader
        title={ticket.ticketNumber}
        breadcrumbs={[{ label: 'Queue Board', href: '/queue' }, { label: ticket.ticketNumber }]}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={ticket.displayStatus} />
            {ticket.queueRank != null && (
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-800 text-sm font-bold">
                #{ticket.queueRank}
              </span>
            )}
          </div>
        }
      />

      {/* Alert Cards */}
      {ticket.blockedReason && (
        <div className="card mb-4 border-red-200 bg-red-50">
          <div className="card-body">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-red-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-red-800">Blocked</p>
                <p className="text-sm text-red-700">{ticket.blockedReason}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {ticket.overrideActive && (
        <div className="card mb-4 border-amber-200 bg-amber-50">
          <div className="card-body">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-amber-800">Override Active</p>
                  <p className="text-sm text-amber-700">{ticket.overrideReasonCode}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input type="text" value={clearReason} onChange={(e) => setClearReason(e.target.value)} placeholder="Reason (optional)" className="input-field w-40 text-xs" />
                <button onClick={() => clearOverride.mutate()} disabled={clearOverride.isPending} className="btn-secondary text-xs">
                  {clearOverride.isPending ? 'Clearing...' : 'Clear Override'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Override Controls */}
      {canOverride && !showOverrideForm && (
        <div className="mb-4">
          <button onClick={() => setShowOverrideForm(true)} className="text-xs text-violet-600 hover:underline font-medium">
            Set Queue Override
          </button>
        </div>
      )}

      {showOverrideForm && (
        <div className="card mb-4 border-violet-200 bg-violet-50">
          <div className="card-body space-y-3">
            <h3 className="text-sm font-semibold text-violet-900">Set Queue Override</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="input-label">Target Position *</label>
                <input type="number" min={1} value={ovrPosition} onChange={(e) => setOvrPosition(Number(e.target.value))} className="input-field" />
              </div>
              <div>
                <label className="input-label">Reason *</label>
                <select value={ovrReason} onChange={(e) => setOvrReason(e.target.value)} className="input-field">
                  {OVERRIDE_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="input-label">Notes</label>
              <input type="text" value={ovrNotes} onChange={(e) => setOvrNotes(e.target.value)} className="input-field" placeholder="Optional" />
            </div>
            {applyOverride.isError && <p className="text-xs text-red-600">{applyOverride.error instanceof Error ? applyOverride.error.message : 'Failed'}</p>}
            <div className="flex gap-2">
              <button onClick={() => applyOverride.mutate()} disabled={applyOverride.isPending} className="btn-primary text-xs">
                {applyOverride.isPending ? 'Applying...' : 'Apply Override'}
              </button>
              <button onClick={() => setShowOverrideForm(false)} className="btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* No-show / Abandon control (CR-2026-018, P3) */}
      {canAbandon && !showAbandonForm && (
        <div className="mb-4">
          <button onClick={() => setShowAbandonForm(true)} className="text-xs text-rose-600 hover:underline font-medium">
            Mark No-Show / Abandoned
          </button>
        </div>
      )}

      {showAbandonForm && (
        <div className="card mb-4 border-rose-200 bg-rose-50">
          <div className="card-body space-y-3">
            <h3 className="text-sm font-semibold text-rose-900">Mark No-Show / Abandoned</h3>
            <p className="text-xs text-rose-700">
              This removes the visit from the active queue and re-ranks the rest. The visit record is kept and the
              change is audited. This cannot be undone from here.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="input-label">Reason *</label>
                <select value={abandonReason} onChange={(e) => setAbandonReason(e.target.value)} className="input-field">
                  {ABANDON_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
              <div>
                <label className="input-label">Notes</label>
                <input type="text" value={abandonNotes} onChange={(e) => setAbandonNotes(e.target.value)} className="input-field" placeholder="Optional" />
              </div>
            </div>
            {abandonVisit.isError && (
              <p className="text-xs text-red-700">{abandonVisit.error instanceof Error ? abandonVisit.error.message : 'Failed to mark abandoned'}</p>
            )}
            <div className="flex gap-2">
              <button onClick={() => abandonVisit.mutate()} disabled={abandonVisit.isPending} className="btn-danger text-xs">
                {abandonVisit.isPending ? 'Marking...' : 'Confirm No-Show'}
              </button>
              <button onClick={() => setShowAbandonForm(false)} className="btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Main Info Card */}
      <div className="card mb-6">
        <div className="card-header">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Ticket Details</h2>
            <span className="text-xs text-slate-500">
              Checked in {ticket.generatedAt ? new Date(ticket.generatedAt).toLocaleTimeString() : '--'}
            </span>
          </div>
        </div>
        <div className="card-body">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
            <div>
              <div className="input-label">Customer</div>
              <p className="text-sm font-medium">
                <Link href={`/customers/${sv.customer.id}`} className="text-blue-600 hover:underline">
                  {sv.customer.firstName} {sv.customer.lastName}
                </Link>
              </p>
            </div>
            <div>
              <div className="input-label">Phone</div>
              <p className="text-sm font-medium text-slate-900">{sv.customer.phone}</p>
            </div>
            <div>
              <div className="input-label">Vehicle</div>
              <p className="text-sm font-medium">
                <Link href={`/vehicles/${sv.vehicle.id}`} className="text-blue-600 hover:underline">
                  {sv.vehicle.plateNumber}
                </Link>
                <span className="text-slate-500 ml-1.5">
                  {[sv.vehicle.make, sv.vehicle.model].filter(Boolean).join(' ')}
                </span>
              </p>
            </div>
            <div>
              <div className="input-label">Source</div>
              <p className="text-sm font-medium text-slate-900">
                {sv.sourceType === 'APPOINTMENT' ? 'Appointment' : 'Walk-In'}
              </p>
            </div>
            <div>
              <div className="input-label">Services</div>
              <p className="text-sm font-medium text-slate-900">{services}</p>
            </div>
            <div>
              <div className="input-label">Parts Readiness</div>
              <p className="text-sm font-medium text-slate-900">{sv.partsReadiness.replace(/_/g, ' ')}</p>
            </div>
            {sv.mileageIn != null && (
              <div>
                <div className="input-label">Mileage In</div>
                <p className="text-sm font-medium text-slate-900">{sv.mileageIn.toLocaleString()}</p>
              </div>
            )}
            {sv.oilBrandRequested && (
              <div>
                <div className="input-label">Oil Requested</div>
                <p className="text-sm font-medium text-slate-900">
                  {sv.oilBrandRequested} {sv.oilGradeRequested ?? ''}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Service Orders Section */}
      <div className="card mb-6">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">
            Service Orders
            {orders.length > 0 && <span className="ml-2 badge bg-slate-100 text-slate-600">{orders.length}</span>}
          </h2>
        </div>
        <div className="card-body">
          {orders.length === 0 ? (
            <p className="text-sm text-slate-500">No service orders created yet.</p>
          ) : (
            <div className="space-y-4">
              {orders.map((order) => (
                <div key={order.id} className="border border-slate-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={order.status} />
                      {order.promisedCompletionAt && (
                        <span className="text-[10px] text-slate-400">
                          Promised: {new Date(order.promisedCompletionAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {/* Status transition buttons */}
                      {order.status === 'DRAFT' && (
                        <button onClick={() => approveOrder.mutate(order.id)} disabled={approveOrder.isPending} className="btn-primary text-xs py-1 px-2">
                          Approve
                        </button>
                      )}
                      {order.status === 'APPROVED' && (
                        <button onClick={() => setAssigningOrderId(order.id)} className="btn-primary text-xs py-1 px-2">
                          Assign
                        </button>
                      )}
                      {(ORDER_ACTIONS[order.status] ?? []).map((action) => (
                        <button
                          key={action.toStatus}
                          onClick={() => changeOrderStatus.mutate({ orderId: order.id, toStatus: action.toStatus })}
                          disabled={changeOrderStatus.isPending}
                          className={`${action.style} text-xs py-1 px-2`}
                        >
                          {action.label}
                        </button>
                      ))}
                      {/* CR-2026-011 pause/resume/rework (dedicated endpoints) */}
                      {order.status === 'IN_PROGRESS' && (
                        <button onClick={() => { setReworkFormOrderId(null); setPauseFormOrderId(pauseFormOrderId === order.id ? null : order.id); }} className="btn-secondary text-xs py-1 px-2">
                          Pause
                        </button>
                      )}
                      {order.status === 'PAUSED' && (
                        <button onClick={() => resumeOrder.mutate({ orderId: order.id })} disabled={resumeOrder.isPending} className="btn-success text-xs py-1 px-2">
                          {resumeOrder.isPending ? 'Resuming...' : 'Resume'}
                        </button>
                      )}
                      {order.status === 'QC' && (
                        <button onClick={() => { setPauseFormOrderId(null); setReworkFormOrderId(reworkFormOrderId === order.id ? null : order.id); }} className="btn-danger text-xs py-1 px-2">
                          Rework
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Pause reason form */}
                  {pauseFormOrderId === order.id && (
                    <div className="card mb-3 border-orange-200 bg-orange-50">
                      <div className="card-body space-y-3">
                        <h3 className="text-xs font-semibold text-slate-900">Pause work</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="input-label">Reason *</label>
                            <select value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} className="input-field">
                              {PAUSE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="input-label">Notes</label>
                            <input value={pauseNotes} onChange={(e) => setPauseNotes(e.target.value)} className="input-field" placeholder="Optional" />
                          </div>
                        </div>
                        {pauseOrder.isError && (
                          <p className="text-xs text-red-700">{pauseOrder.error instanceof Error ? pauseOrder.error.message : 'Failed to pause'}</p>
                        )}
                        <div className="flex gap-2">
                          <button onClick={() => pauseOrder.mutate({ orderId: order.id })} disabled={pauseOrder.isPending} className="btn-primary text-xs py-1 px-3">
                            {pauseOrder.isPending ? 'Pausing...' : 'Confirm Pause'}
                          </button>
                          <button onClick={() => setPauseFormOrderId(null)} className="btn-secondary text-xs py-1 px-3">Cancel</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Rework reason form */}
                  {reworkFormOrderId === order.id && (
                    <div className="card mb-3 border-red-200 bg-red-50">
                      <div className="card-body space-y-3">
                        <h3 className="text-xs font-semibold text-slate-900">Send back for rework (from QC)</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="input-label">Reason *</label>
                            <select value={reworkReason} onChange={(e) => setReworkReason(e.target.value)} className="input-field">
                              {REWORK_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="input-label">Description</label>
                            <input value={reworkDesc} onChange={(e) => setReworkDesc(e.target.value)} className="input-field" placeholder="What needs redoing? (optional)" />
                          </div>
                        </div>
                        {reworkOrder.isError && (
                          <p className="text-xs text-red-700">{reworkOrder.error instanceof Error ? reworkOrder.error.message : 'Failed to open rework'}</p>
                        )}
                        <div className="flex gap-2">
                          <button onClick={() => reworkOrder.mutate({ orderId: order.id })} disabled={reworkOrder.isPending} className="btn-danger text-xs py-1 px-3">
                            {reworkOrder.isPending ? 'Opening...' : 'Confirm Rework'}
                          </button>
                          <button onClick={() => setReworkFormOrderId(null)} className="btn-secondary text-xs py-1 px-3">Cancel</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Line items */}
                  <div className="space-y-1">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex items-center justify-between text-xs">
                        <span className="text-slate-700">{item.serviceType.name}</span>
                        <span className="text-slate-400">
                          {item.estimateMinutes != null ? `~${item.estimateMinutes} min` : ''}
                          {item.actualMinutes != null ? ` (actual: ${item.actualMinutes} min)` : ''}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Assignments */}
                  {order.assignments.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-slate-100 flex flex-wrap gap-2">
                      {order.assignments.map((a) => (
                        <span key={a.id} className="badge bg-blue-50 text-blue-700 text-[10px]">
                          {a.technician.employeeCode} {a.isPrimary ? '(Primary)' : '(Helper)'}
                          {a.bay ? ` — ${a.bay.code}` : ''}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Assign form (inline) */}
                  {assigningOrderId === order.id && (
                    <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="input-label">Technician *</label>
                          <select value={assignTechId} onChange={(e) => setAssignTechId(e.target.value)} className="input-field text-xs">
                            <option value="">Select...</option>
                            {(techsQuery.data ?? []).map((t) => (
                              <option key={t.id} value={t.id}>{t.employeeCode} — {t.userAccount.fullName}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="input-label">Bay (optional)</label>
                          <input type="text" value={assignBayId} onChange={(e) => setAssignBayId(e.target.value)} className="input-field text-xs" placeholder="Bay UUID or leave blank" />
                        </div>
                      </div>
                      {assignOrder.isError && <p className="text-xs text-red-600">{assignOrder.error instanceof Error ? assignOrder.error.message : 'Failed'}</p>}
                      <div className="flex gap-2">
                        <button onClick={() => assignOrder.mutate({ orderId: order.id })} disabled={!assignTechId || assignOrder.isPending} className="btn-primary text-xs">
                          {assignOrder.isPending ? 'Assigning...' : 'Assign'}
                        </button>
                        <button onClick={() => setAssigningOrderId(null)} className="btn-secondary text-xs">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Transport Section (P2) */}
      {canTransport && (
        <div className="card mb-6">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Transport</h2>
          </div>
          <div className="card-body space-y-3">
            {transportRequests.length === 0 ? (
              <p className="text-sm text-slate-500">No transport requests for this visit.</p>
            ) : (
              <div className="space-y-2">
                {transportRequests.map((t) => (
                  <div key={t.id} className="flex items-center justify-between border border-slate-200 rounded-md px-3 py-2">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={t.status} />
                      <span className="text-xs text-slate-600">{t.direction === 'PICKUP' ? 'Pickup' : 'Drop-off'}</span>
                      {t.driver?.fullName && <span className="text-xs text-slate-400">&middot; {t.driver.fullName}</span>}
                    </div>
                    <span className="text-xs text-slate-400">
                      {t.scheduledPickupAt
                        ? new Date(t.scheduledPickupAt).toLocaleString()
                        : t.requestedPickupAt
                          ? new Date(t.requestedPickupAt).toLocaleString()
                          : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {sv.sourceType !== 'APPOINTMENT' ? (
              <p className="text-xs text-slate-400">
                Transport can only be requested for appointment visits with a transport-eligible service.
              </p>
            ) : hasActiveTransport ? (
              <p className="text-xs text-slate-400">An active transport request already exists for this visit.</p>
            ) : !showTransportForm ? (
              <button onClick={() => setShowTransportForm(true)} className="text-xs text-blue-600 hover:underline font-medium">
                Request Transport
              </button>
            ) : (
              <div className="card border-blue-200 bg-blue-50">
                <div className="card-body space-y-3">
                  <h3 className="text-xs font-semibold text-slate-900">Request transport</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="input-label">Direction *</label>
                      <select value={transportDirection} onChange={(e) => setTransportDirection(e.target.value as 'DROPOFF' | 'PICKUP')} className="input-field">
                        <option value="DROPOFF">Drop-off</option>
                        <option value="PICKUP">Pickup</option>
                      </select>
                    </div>
                    <div>
                      <label className="input-label">Requested pickup</label>
                      <input type="datetime-local" value={transportPickupAt} onChange={(e) => setTransportPickupAt(e.target.value)} className="input-field" />
                    </div>
                  </div>
                  <div>
                    <label className="input-label">Notes</label>
                    <input type="text" value={transportNotes} onChange={(e) => setTransportNotes(e.target.value)} className="input-field" placeholder="Optional" />
                  </div>
                  {createTransport.isError && (
                    <p className="text-xs text-red-600">{createTransport.error instanceof Error ? createTransport.error.message : 'Failed to create transport request'}</p>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => createTransport.mutate()} disabled={createTransport.isPending} className="btn-primary text-xs">
                      {createTransport.isPending ? 'Requesting...' : 'Create Request'}
                    </button>
                    <button onClick={() => setShowTransportForm(false)} className="btn-secondary text-xs">Cancel</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Visit Completion Section */}
      {showCompletionSection && (
        <div className="card mb-6 border-emerald-200">
          <div className="card-header bg-emerald-50/50">
            <h2 className="text-sm font-semibold text-emerald-900">Complete Visit</h2>
          </div>
          <div className="card-body">
            {!showCompletion ? (
              <button onClick={() => setShowCompletion(true)} className="btn-success text-sm">
                Record Completion Details
              </button>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="input-label">Mileage Out</label>
                    <input type="number" value={mileageOut} onChange={(e) => setMileageOut(e.target.value)} className="input-field" placeholder={sv.mileageIn != null ? `Min: ${sv.mileageIn}` : ''} />
                    {sv.mileageIn != null && mileageOut && parseInt(mileageOut, 10) < sv.mileageIn && (
                      <p className="text-[10px] text-red-500 mt-1">Must be ≥ mileage in ({sv.mileageIn.toLocaleString()})</p>
                    )}
                  </div>
                  <div>
                    <label className="input-label">Oil Brand Installed</label>
                    <select value={oilBrandInstalled} onChange={(e) => setOilBrandInstalled(e.target.value)} className="input-field">
                      <option value="">-- Select --</option>
                      <option value="Amsoil">Amsoil</option>
                      <option value="Liqui Moly">Liqui Moly</option>
                      <option value="Valvoline">Valvoline</option>
                      <option value="Castrol">Castrol</option>
                      <option value="Mobil 1">Mobil 1</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="input-label">Oil Grade Installed</label>
                    <select value={oilGradeInstalled} onChange={(e) => setOilGradeInstalled(e.target.value)} className="input-field">
                      <option value="">-- Select --</option>
                      <option value="0W-20">0W-20</option>
                      <option value="5W-20">5W-20</option>
                      <option value="5W-30">5W-30</option>
                      <option value="10W-30">10W-30</option>
                      <option value="10W-40">10W-40</option>
                      <option value="15W-40">15W-40</option>
                      <option value="0W-40">0W-40</option>
                    </select>
                  </div>
                </div>
                {/* P4(c): vehicle-release payment gate (GOV-005) */}
                {paymentBlocked && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
                    <p className="text-xs font-semibold text-amber-800">
                      Payment not cleared on {unpaidOrders.length} order{unpaidOrders.length > 1 ? 's' : ''}
                      {' '}({unpaidOrders.map((o) => o.paymentStatus).join(', ')}). Release is blocked.
                    </p>
                    {isManager ? (
                      <>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={paymentOverride} onChange={(e) => setPaymentOverride(e.target.checked)}
                            className="rounded border-slate-300 text-amber-600 focus:ring-amber-500" />
                          <span className="text-xs text-amber-800">Authorize manager release exception (audited)</span>
                        </label>
                        {paymentOverride && (
                          <input type="text" value={paymentOverrideReason} onChange={(e) => setPaymentOverrideReason(e.target.value)}
                            className="input-field text-xs" placeholder="Reason for releasing without cleared payment (required)" />
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-amber-700">A manager or admin must authorize release without cleared payment.</p>
                    )}
                  </div>
                )}
                {completeVisit.isError && (
                  <p className="text-xs text-red-600">{completeVisit.error instanceof Error ? completeVisit.error.message : 'Failed to complete'}</p>
                )}
                {completeVisit.isSuccess && (
                  <p className="text-xs text-emerald-600 font-medium">Visit completed successfully.</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => completeVisit.mutate()}
                    disabled={releaseDisabled}
                    className="btn-success text-xs"
                  >
                    {completeVisit.isPending ? 'Completing...' : 'Complete & Close Visit'}
                  </button>
                  <button onClick={() => setShowCompletion(false)} className="btn-secondary text-xs">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Event History Table */}
      <div className="table-container">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">Event History</h2>
        </div>
        {ticket.queueEvents.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No events recorded.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="table-header">
                <th>Time</th>
                <th>Event</th>
                <th>Position</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {ticket.queueEvents.map((evt) => (
                <tr key={evt.id} className="table-row">
                  <td className="text-slate-500 whitespace-nowrap">
                    {new Date(evt.createdAt).toLocaleTimeString()}
                  </td>
                  <td className="font-medium text-slate-900">
                    {evt.eventType.replace(/_/g, ' ')}
                  </td>
                  <td className="text-slate-600">
                    {evt.positionBefore != null && (
                      <>
                        {evt.positionBefore}
                        {evt.positionAfter != null && (
                          <>
                            <span className="mx-1 text-slate-400">&rarr;</span>
                            {evt.positionAfter}
                          </>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {evt.reasonCode && (
                      <span className="badge bg-slate-100 text-slate-600">{evt.reasonCode}</span>
                    )}
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
