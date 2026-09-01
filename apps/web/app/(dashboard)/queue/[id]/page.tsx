'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, ApiError } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../components/status-badge';
import { useSiteId } from '../../../../hooks/use-site';
import { useAuth } from '../../../../hooks/use-auth';
import { PAUSE_REASONS, REWORK_REASONS } from '../../../../lib/service-order-actions';
import { SearchableSelect } from '../../../../components/ui/searchable-select';
import { ServiceQualifiers } from '../../../../components/service-qualifiers';
import { qualifierSummary, type QualifierItem } from '../../../../lib/service-qualifiers';
import { VisitNotesCard } from '../../../../components/visit-notes-card';
import {
  CustomerNotificationComposer,
  type ComposerContext,
} from '../../../../components/notification-composer';
import { CommunicationHistory } from '../../../../components/communication-history';

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
    serviceOrders?: Array<{ items: Array<{ serviceType: { name: string; code: string } }> }>;
    // CR-2026-085 — surfaced so staff can re-send the customer's status link.
    customerStatusToken?: string | null;
    tokenExpiresAt?: string | null;
  };
  // CR-2026-084 — server-resolved service list (appointment services + order items).
  serviceDescription?: string;
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
  // CR-2026-092 — the line carries its own qualifiers: no service code says which
  // axle it covers, nor whether brake work is pads, shoes, a rotor or a bleed.
  items: Array<
    QualifierItem & {
      estimateMinutes: number | null;
      actualMinutes: number | null;
      status: string;
    }
  >;
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

// CR-2026-035 — recommended technicians (advisory ranking).
interface RecommendedTech {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  openAssignments: number;
  shiftStatus: string;
  score: number;
}
interface RecommendedResult {
  compatibleBays: Array<{ id: string; code: string; bayType: string }>;
  technicians: RecommendedTech[];
}

const OVERRIDE_REASONS = ['CUSTOMER_REQUEST', 'MANAGER_ESCALATION', 'VIP', 'URGENT_REPAIR', 'OTHER'];
const DISPATCHABLE_STATUSES = ['WAITING', 'ISSUED', 'PENDING_RANK', 'BLOCKED'];

// CR-2026-018 (P3) — no-show / abandon. Mirrors the backend QUEUE_ABANDON grant
// (SERVICE_ADVISOR + ADMIN) and the abandonable-status set.
const ABANDON_REASONS = ['NO_SHOW', 'LEFT_BEFORE_SERVICE', 'CUSTOMER_CANCELLED_ONSITE', 'UNREACHABLE', 'OTHER'];
const ABANDON_ROLES = ['ADMIN', 'SERVICE_ADVISOR'];
const ABANDONABLE_VISIT_STATUSES = ['CREATED', 'ARRIVED', 'CHECKED_IN', 'QUEUED', 'CALLED', 'IN_SERVICE', 'WAITING_PARTS'];

const ORDER_ACTIONS: Record<string, Array<{ label: string; toStatus: string; style: string }>> = {
  // CR-2026-077 — DRAFT's Approve is rendered by the dedicated button below (POST /approve);
  // leaving it here too produced a duplicate "Approve".
  DRAFT: [],
  APPROVED: [],
  // CR-2026-069 — the assigned technician starts work from their own device, not the
  // front desk / manager. No "Start Work" here once ASSIGNED.
  ASSIGNED: [],
  // CR-2026-085 — labels now describe what pressing the button actually does.
  // "Send to QC" moved work INTO the quality check, so calling that "Complete
  // Quality Check" would have been backwards; the button that genuinely completes
  // the check is the one at the QC stage, which used to say "Ready to Invoice".
  IN_PROGRESS: [
    { label: 'Mark Work Complete', toStatus: 'QC', style: 'btn-primary' },
    { label: 'Waiting for Parts', toStatus: 'WAITING_PARTS', style: 'btn-secondary' },
    { label: 'Waiting on Customer', toStatus: 'WAITING_CUSTOMER', style: 'btn-secondary' },
  ],
  WAITING_PARTS: [{ label: 'Resume Work', toStatus: 'IN_PROGRESS', style: 'btn-success' }],
  WAITING_CUSTOMER: [{ label: 'Resume Work', toStatus: 'IN_PROGRESS', style: 'btn-success' }],
  QC: [{ label: 'Complete Quality Check', toStatus: 'READY_TO_INVOICE', style: 'btn-primary' }],
  READY_TO_INVOICE: [{ label: 'Close Order', toStatus: 'CLOSED', style: 'btn-success' }],
};

/* ---------- Component ---------- */

export default function QueueTicketDetailPage() {
  const params = useParams();
  const ticketId = params.id as string;
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  // CR-2026-034 (C-4) — who can start a visual inspection (API enforces).
  const canInspect = ['ADMIN', 'SERVICE_ADVISOR', 'TECHNICIAN'].includes(user?.roleCode ?? '');
  // CR-2026-057 — who can create/approve/assign service orders (API enforces).
  const canManageOrders = ['ADMIN', 'SERVICE_ADVISOR'].includes(user?.roleCode ?? '');

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

  // CR-2026-057 — create service order. Appointments prefill from requested
  // services (one click); walk-ins (no appointment services) pick from the
  // catalogue via this fallback form.
  const [showServicePicker, setShowServicePicker] = useState(false);
  const [pickedServiceCodes, setPickedServiceCodes] = useState<string[]>([]);
  // CR-2026-071 — edit an existing order's services.
  const [editOrderId, setEditOrderId] = useState<string | null>(null);
  const [editPickedCodes, setEditPickedCodes] = useState<string[]>([]);

  // CR-2026-068 — assign one tech to all approved orders; reassign a not-started order.
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkTechId, setBulkTechId] = useState('');
  const [reassignOrderId, setReassignOrderId] = useState<string | null>(null);
  const [reassignTechId, setReassignTechId] = useState('');

  // Pause / rework form state (CR-2026-011) — keyed by order id
  const [pauseFormOrderId, setPauseFormOrderId] = useState<string | null>(null);
  const [pauseReason, setPauseReason] = useState<string>(PAUSE_REASONS[0].value);
  const [pauseNotes, setPauseNotes] = useState('');

  // CR-2026-100 — the shared hold story for one order (§18): every role reads
  // the same ledger — who reported, who acknowledged, effective from when.
  const [holdHistoryOrderId, setHoldHistoryOrderId] = useState<string | null>(null);

  // CR-2026-100 — pause acknowledgement review + retroactive correction state.
  const [rejectingPauseId, setRejectingPauseId] = useState<string | null>(null);
  const [rejectPauseReason, setRejectPauseReason] = useState('');
  const [correctingPauseId, setCorrectingPauseId] = useState<string | null>(null);
  const [correctTime, setCorrectTime] = useState('');
  const [correctReason, setCorrectReason] = useState('');
  // CR-2026-100 — workload warning from assign (409): shown for judgement, never a wall.
  const [workloadWarning, setWorkloadWarning] = useState<{
    scope: 'one' | 'all';
    orderId?: string;
    message: string;
  } | null>(null);
  const [reworkFormOrderId, setReworkFormOrderId] = useState<string | null>(null);
  const [reworkReason, setReworkReason] = useState<string>(REWORK_REASONS[0].value);
  const [reworkDesc, setReworkDesc] = useState('');

  // Completion form state. CR-2026-085 — the payment-release exception state is
  // gone with GOV-005; closing a visit no longer depends on payment.
  const [showCompletion, setShowCompletion] = useState(false);
  const [mileageOut, setMileageOut] = useState('');
  // CR-2026-072 — completion captures optional mileage + optional notes (oil dropped here).
  const [completionNotes, setCompletionNotes] = useState('');
  // CR-2026-085 — feedback for the "copy customer link" button.
  const [linkCopied, setLinkCopied] = useState(false);

  // Abandon / no-show form state (CR-2026-018, P3)
  const [showAbandonForm, setShowAbandonForm] = useState(false);
  const [abandonReason, setAbandonReason] = useState(ABANDON_REASONS[0]);
  const [abandonNotes, setAbandonNotes] = useState('');

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

  // CR-2026-063 — parts-prepositioned acknowledgement (audit-backed; shown only when
  // the visit's services actually involve parts, i.e. partsReadiness !== NOT_REQUIRED).
  const partsRelevant = !!ticket && ticket.serviceVisit.partsReadiness !== 'NOT_REQUIRED';
  const partsAckQuery = useQuery<{ acknowledged: boolean; at: string | null; by: string | null }>({
    queryKey: ['parts-ack', ticket?.serviceVisit?.id],
    queryFn: () => api.get(`/service-visits/${ticket!.serviceVisit.id}/parts-ack`),
    enabled: partsRelevant,
  });
  const acknowledgeParts = useMutation({
    mutationFn: (acknowledged: boolean) =>
      api.post(`/service-visits/${ticket!.serviceVisit.id}/acknowledge-parts`, { acknowledged }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['parts-ack', ticket?.serviceVisit?.id] }),
  });

  // CR-2026-096 — customer contact goes through the shared composer; "Log Call"
  // records a manual outreach without sending anything.
  const [composerCtx, setComposerCtx] = useState<ComposerContext | null>(null);
  const logCall = useMutation({
    mutationFn: () =>
      api.post('/notifications/manual-contact', {
        customerId: ticket!.serviceVisit.customer.id,
        vehicleId: ticket!.serviceVisit.vehicle.id,
        serviceVisitId: ticket!.serviceVisit.id,
        reason: ticket!.serviceVisit.status === 'READY_FOR_PICKUP' ? 'PICKUP_READY' : 'QUEUE_UPDATE',
        method: 'PHONE_CALL',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notification-history'] }),
  });
  const openComposer = () => {
    const sv = ticket!.serviceVisit;
    setComposerCtx({
      reason: sv.status === 'READY_FOR_PICKUP' ? 'PICKUP_READY' : 'QUEUE_UPDATE',
      customerId: sv.customer.id,
      vehicleId: sv.vehicle.id,
      serviceVisitId: sv.id,
    });
  };

  // CR-2026-093 — the inspection workspace opens straight from the queue: existing
  // records open, missing ones are created on the spot, and the workspace's tabs
  // carry the rest.
  const inspectionsQuery = useQuery<{
    items: Array<{ id: string; inspectionNumber: string; status: string; kind: string; createdAt: string }>;
  }>({
    queryKey: ['inspections-by-visit', ticket?.serviceVisit?.id],
    queryFn: () => api.get(`/inspections?serviceVisitId=${ticket!.serviceVisit.id}`),
    enabled: !!ticket?.serviceVisit?.id,
  });
  const startInspection = useMutation({
    mutationFn: (kind: 'VEHICLE_INSPECTION' | 'PRE_INSPECTION') =>
      api.post<{ id: string }>('/inspections', { serviceVisitId: ticket!.serviceVisit.id, kind }),
    onSuccess: (created) => router.push(`/inspections/${created.id}`),
  });
  const openOrStart = (kind: 'VEHICLE_INSPECTION' | 'PRE_INSPECTION') => {
    const existing = (inspectionsQuery.data?.items ?? [])
      .filter((i) => i.kind === kind && i.status !== 'CANCELLED')
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
    if (existing) router.push(`/inspections/${existing.id}`);
    else startInspection.mutate(kind);
  };

  const techsQuery = useQuery<TechOption[]>({
    queryKey: ['technicians-list', siteId],
    queryFn: () => api.get(`/technicians?siteId=${siteId}`),
    enabled: !!assigningOrderId || bulkAssignOpen || !!reassignOrderId,
  });

  // CR-2026-035 — ranked recommendations for the order being assigned (advisory).
  const recommendationsQuery = useQuery<RecommendedResult>({
    queryKey: ['tech-recommendations', assigningOrderId],
    queryFn: () => api.get(`/technicians/recommended/${assigningOrderId}`),
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
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      queryClient.invalidateQueries({ queryKey: ['queue-ticket', ticketId] });
      // CR-2026-085 — passing the quality check is the moment the car is finished,
      // so hand the close-out straight to the user instead of making them hunt for
      // a collapsed panel further down the page.
      if (variables.toStatus === 'READY_TO_INVOICE') setShowCompletion(true);
    },
  });

  const approveOrder = useMutation({
    mutationFn: (orderId: string) => api.post(`/service-orders/${orderId}/approve`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service-orders'] }),
  });

  // CR-2026-057 — service catalogue for the walk-in fallback picker.
  const serviceTypesQuery = useQuery<Array<{ id: string; code: string; name: string }>>({
    queryKey: ['service-types'],
    queryFn: () => api.get('/service-types'),
    enabled: showServicePicker || !!editOrderId,
  });

  // CR-2026-057 — create a service order for this visit from a set of service codes.
  const createOrder = useMutation({
    mutationFn: (serviceTypeCodes: string[]) =>
      api.post('/service-orders', {
        serviceVisitId: ticket!.serviceVisit.id,
        items: serviceTypeCodes.map((code) => ({ serviceTypeCode: code })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      setShowServicePicker(false);
      setPickedServiceCodes([]);
    },
  });

  // CR-2026-071 — edit / delete a service order (before work is assigned).
  const updateOrder = useMutation({
    mutationFn: ({ orderId, codes }: { orderId: string; codes: string[] }) =>
      api.patch(`/service-orders/${orderId}`, { items: codes.map((code) => ({ serviceTypeCode: code })) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      setEditOrderId(null);
      setEditPickedCodes([]);
    },
  });
  const deleteOrder = useMutation({
    mutationFn: (orderId: string) => api.delete(`/service-orders/${orderId}`),
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

  // CR-2026-100 — a 409 here is the technician's existing workload asking for
  // judgement, not an error: surface it and let the advisor assign anyway.
  const workloadMessageFrom = (err: unknown): string | null =>
    err instanceof ApiError && (err.body as { code?: string })?.code === 'TECHNICIAN_HAS_OPEN_WORK'
      ? ((err.body as { message?: string }).message ?? 'This technician already has open work.')
      : null;

  const assignOrder = useMutation({
    mutationFn: ({ orderId, acknowledgeWorkload }: { orderId: string; acknowledgeWorkload?: boolean }) =>
      api.post(`/service-orders/${orderId}/assign`, {
        technicianId: assignTechId,
        bayId: assignBayId || undefined,
        ...(acknowledgeWorkload ? { acknowledgeWorkload: true } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      setAssigningOrderId(null);
      setAssignTechId('');
      setAssignBayId('');
      setWorkloadWarning(null);
    },
    onError: (err, vars) => {
      const message = workloadMessageFrom(err);
      if (message) setWorkloadWarning({ scope: 'one', orderId: vars.orderId, message });
    },
  });

  // CR-2026-068 — assign one tech to ALL approved orders on the visit in one action.
  const assignAll = useMutation({
    mutationFn: ({ technicianId, acknowledgeWorkload }: { technicianId: string; acknowledgeWorkload?: boolean }) =>
      api.post(`/service-orders/by-visit/${ticket!.serviceVisit.id}/assign-all`, {
        technicianId,
        ...(acknowledgeWorkload ? { acknowledgeWorkload: true } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      setBulkAssignOpen(false);
      setBulkTechId('');
      setWorkloadWarning(null);
    },
    onError: (err) => {
      const message = workloadMessageFrom(err);
      if (message) setWorkloadWarning({ scope: 'all', message });
    },
  });

  // CR-2026-100 — pause requests on THIS visit awaiting acknowledgement.
  const pendingPausesQuery = useQuery<
    Array<{
      pauseId: string;
      orderId: string;
      serviceVisitId: string;
      ticketNumber: string | null;
      technicianName: string | null;
      reasonCode: string;
      notes: string | null;
      requestedAt: string;
      enteredOnBehalf: boolean;
      waitingMinutes: number;
    }>
  >({
    queryKey: ['pause-approvals', siteId],
    queryFn: () => api.get(`/service-orders/pause-approvals/pending?siteId=${siteId}`),
    enabled: canManageOrders && !!siteId,
    refetchInterval: 15000,
  });
  const invalidatePauses = () => {
    invalidateOrders();
    queryClient.invalidateQueries({ queryKey: ['pause-approvals'] });
  };
  const approvePause = useMutation({
    mutationFn: ({ orderId, pauseId }: { orderId: string; pauseId: string }) =>
      api.post(`/service-orders/${orderId}/pauses/${pauseId}/approve`, {}),
    onSuccess: invalidatePauses,
  });
  const rejectPause = useMutation({
    mutationFn: ({ orderId, pauseId }: { orderId: string; pauseId: string }) =>
      api.post(`/service-orders/${orderId}/pauses/${pauseId}/reject`, { reason: rejectPauseReason.trim() }),
    onSuccess: () => {
      setRejectingPauseId(null);
      setRejectPauseReason('');
      invalidatePauses();
    },
  });
  const correctPause = useMutation({
    mutationFn: ({ orderId, pauseId }: { orderId: string; pauseId: string }) =>
      api.post(`/service-orders/${orderId}/pauses/${pauseId}/correct-start`, {
        effectiveFrom: new Date(correctTime).toISOString(),
        reason: correctReason.trim(),
      }),
    onSuccess: () => {
      setCorrectingPauseId(null);
      setCorrectTime('');
      setCorrectReason('');
      invalidatePauses();
      queryClient.invalidateQueries({ queryKey: ['order-pauses'] });
    },
  });

  // CR-2026-100 §18 — the full hold ledger for one order, fetched when opened.
  const holdHistoryQuery = useQuery<
    Array<{
      id: string;
      reasonCode: string;
      notes: string | null;
      startedAt: string;
      endedAt: string | null;
      technicianName: string | null;
      recordedByName: string | null;
      resumedByName: string | null;
      enteredOnBehalf: boolean;
      approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
      reviewedByName: string | null;
      reviewedAt: string | null;
      reviewNotes: string | null;
      originalStartedAt: string | null;
      correctedByName: string | null;
      correctionReason: string | null;
    }>
  >({
    queryKey: ['order-pauses', holdHistoryOrderId],
    queryFn: () => api.get(`/service-orders/${holdHistoryOrderId}/pauses`),
    enabled: !!holdHistoryOrderId,
  });

  // CR-2026-068 — reassign a not-started order to a different technician.
  const reassign = useMutation({
    mutationFn: ({ orderId, assignmentId, technicianId }: { orderId: string; assignmentId: string; technicianId: string }) =>
      api.patch(`/service-orders/${orderId}/assignments/${assignmentId}`, { technicianId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
      setReassignOrderId(null);
      setReassignTechId('');
    },
  });

  const completeVisit = useMutation({
    mutationFn: () => api.patch(`/service-visits/${ticket!.serviceVisit.id}/completion`, {
      mileageOut: mileageOut ? parseInt(mileageOut, 10) : undefined,
      notes: completionNotes.trim() || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue-ticket', ticketId] });
      queryClient.invalidateQueries({ queryKey: ['service-orders'] });
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
  // CR-2026-084 — resolved by the API from the appointment AND the service orders,
  // so a walk-in shows what it actually came in for instead of "Walk-in service".
  const services = ticket.serviceDescription ?? 'No services recorded';
  const orders = ordersQuery.data ?? [];
  const canOverride = !ticket.overrideActive && DISPATCHABLE_STATUSES.includes(ticket.displayStatus);
  const showCompletionSection = sv.status === 'READY_FOR_PICKUP' || sv.status === 'QC';
  const isManager = ['ADMIN'].includes(user?.roleCode ?? '');
  // CR-2026-085 — the customer's own status link, available for every visit rather
  // than only on the walk-in confirmation screen.
  const statusLink =
    sv.customerStatusToken && typeof window !== 'undefined'
      ? `${window.location.origin}/status/${sv.customerStatusToken}`
      : null;
  const statusLinkExpired =
    !!sv.tokenExpiresAt && new Date(sv.tokenExpiresAt).getTime() < Date.now();
  // CR-2026-085 — GOV-005 withdrawn: payment lives in the external POS and no longer
  // gates release. The only thing that can hold up a close-out now is a mileage-out
  // reading lower than mileage-in, which is a data error rather than a policy.
  const releaseDisabled =
    completeVisit.isPending ||
    (!!mileageOut && sv.mileageIn != null && parseInt(mileageOut, 10) < sv.mileageIn);
  const canAbandon =
    ABANDON_ROLES.includes(user?.roleCode ?? '') &&
    sv.sourceType !== 'HISTORICAL_IMPORT' &&
    ABANDONABLE_VISIT_STATUSES.includes(sv.status) &&
    !['COMPLETED', 'CANCELLED'].includes(ticket.displayStatus);

  return (
    <div className="page-container">
      <PageHeader
        title={ticket.ticketNumber}
        breadcrumbs={[{ label: 'Queue Board', href: '/queue' }, { label: ticket.ticketNumber }]}
        actions={
          <div className="flex items-center gap-2">
            <Link href={`/visits/${sv.id}`} className="btn-secondary text-xs" title="The complete record of this visit — job sheet, inspections, photos, activity">
              Visit Record
            </Link>
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
              {sv.partsReadiness !== 'NOT_REQUIRED' && (
                partsAckQuery.data?.acknowledged ? (
                  <div className="mt-1">
                    <div className="flex items-center gap-2">
                      <span className="badge bg-emerald-50 text-emerald-700 text-[10px]">✓ Parts prepositioned</span>
                      <button onClick={() => acknowledgeParts.mutate(false)} disabled={acknowledgeParts.isPending} className="text-[10px] text-slate-400 hover:text-slate-600">clear</button>
                    </div>
                    {partsAckQuery.data.by && <p className="text-[10px] text-slate-400 mt-0.5">by {partsAckQuery.data.by}</p>}
                  </div>
                ) : (
                  <button onClick={() => acknowledgeParts.mutate(true)} disabled={acknowledgeParts.isPending} className="mt-1 text-[11px] text-blue-600 hover:underline font-medium">
                    {acknowledgeParts.isPending ? 'Saving…' : 'Acknowledge parts prepositioned'}
                  </button>
                )
              )}
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

      {/*
        CR-2026-085 — Customer Status Link.
        This link is minted for EVERY visit, but the only place it was ever shown was
        the walk-in success screen, so in practice it existed only for walk-ins and
        only for the few seconds that screen was open. The ticket is the right home
        for it: staff can pull it up for any active visit, at any point, and re-send
        it to a customer who lost it.
      */}
      {statusLink && (
        <div className="card mb-6 border-blue-200">
          <div className="card-header bg-blue-50/50 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-blue-900">Customer Status Link</h2>
            {statusLinkExpired && (
              <span className="badge bg-amber-100 text-amber-800 text-[10px]">Expired</span>
            )}
          </div>
          <div className="card-body space-y-2">
            <p className="text-xs text-slate-500">
              Text or hand this to the customer — it shows their place in line and
              progress, with no prices and only a masked plate.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="flex-1 min-w-[12rem] text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5 text-slate-700 break-all">
                {statusLink}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(statusLink).then(
                    () => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); },
                    () => setLinkCopied(false),
                  );
                }}
                className="btn-secondary text-xs"
              >
                {linkCopied ? 'Copied' : 'Copy'}
              </button>
              <a href={statusLink} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs">
                Open
              </a>
            </div>
            {statusLinkExpired && (
              <p className="text-[11px] text-amber-700">
                This link has passed its 24-hour window and will show the customer an
                expired notice.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Service Orders Section */}
      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            Service Orders
            {orders.length > 0 && <span className="ml-2 badge bg-slate-100 text-slate-600">{orders.length}</span>}
          </h2>
          {canManageOrders && !showServicePicker && (() => {
            const apptCodes = (ticket.serviceVisit.appointment?.services ?? []).map((s) => s.serviceType.code);
            return (
              <button
                onClick={() => {
                  if (apptCodes.length > 0) {
                    // One-click: prefill from the appointment's requested services.
                    createOrder.mutate(apptCodes);
                  } else {
                    // Walk-in / no requested services — open the catalogue picker.
                    setPickedServiceCodes([]);
                    setShowServicePicker(true);
                  }
                }}
                disabled={createOrder.isPending}
                className="btn-primary text-xs py-1 px-2"
              >
                {createOrder.isPending
                  ? 'Creating...'
                  : apptCodes.length > 0
                    ? `+ Create Service Order (${apptCodes.length})`
                    : '+ Create Service Order'}
              </button>
            );
          })()}
        </div>
        <div className="card-body">
          {createOrder.isError && (
            <p className="text-xs text-red-600 mb-3">{createOrder.error instanceof Error ? createOrder.error.message : 'Failed to create service order'}</p>
          )}

          {/* Walk-in / no-appointment fallback: pick services from the catalogue */}
          {showServicePicker && (
            <div className="mb-4 pb-4 border-b border-slate-100 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-900">Select services for this order</h3>
                <button onClick={() => { setShowServicePicker(false); setPickedServiceCodes([]); }} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
              </div>
              {serviceTypesQuery.isLoading ? (
                <p className="text-xs text-slate-500">Loading services…</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto">
                  {(serviceTypesQuery.data ?? []).map((st) => {
                    const checked = pickedServiceCodes.includes(st.code);
                    return (
                      <label key={st.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setPickedServiceCodes((prev) =>
                              e.target.checked ? [...prev, st.code] : prev.filter((c) => c !== st.code),
                            )
                          }
                        />
                        <span>{st.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <button
                onClick={() => createOrder.mutate(pickedServiceCodes)}
                disabled={pickedServiceCodes.length === 0 || createOrder.isPending}
                className="btn-primary text-xs py-1 px-3"
              >
                {createOrder.isPending ? 'Creating...' : `Create Order${pickedServiceCodes.length ? ` (${pickedServiceCodes.length})` : ''}`}
              </button>
            </div>
          )}

          {/* CR-2026-100 §5/§9 — technician pause requests on THIS visit awaiting
              acknowledgement. Approval never moves the clock (it has run from the
              technician's own timestamp all along); rejection needs a reason and
              resumes the work; a correction moves the effective start EARLIER
              only, reasoned and audited, original kept. */}
          {canManageOrders &&
            (pendingPausesQuery.data ?? [])
              .filter((p) => p.serviceVisitId === ticket.serviceVisit.id)
              .map((p) => (
                <div key={p.pauseId} className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-amber-900">
                      Pause approval required — {PAUSE_REASONS.find((r) => r.value === p.reasonCode)?.label ?? p.reasonCode}
                    </p>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 shrink-0">
                      waiting {p.waitingMinutes} min
                    </span>
                  </div>
                  <p className="text-xs text-amber-800">
                    {p.technicianName ? `${p.technicianName} requested ` : 'Requested '}
                    {new Date(p.requestedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    {p.enteredOnBehalf ? ' (entered on the technician’s behalf)' : ''} · the clock stopped at that
                    moment — approving records your acknowledgement, it never moves the time.
                  </p>
                  {p.notes && <p className="text-xs text-amber-700 italic">“{p.notes}”</p>}

                  {rejectingPauseId === p.pauseId ? (
                    <div className="space-y-1.5">
                      <input
                        value={rejectPauseReason}
                        onChange={(e) => setRejectPauseReason(e.target.value)}
                        placeholder="Why is this rejected? (required — the technician sees it)"
                        className="input-field text-xs"
                      />
                      {rejectPause.isError && (
                        <p className="text-[11px] text-red-600">{rejectPause.error instanceof Error ? rejectPause.error.message : 'Failed'}</p>
                      )}
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => rejectPause.mutate({ orderId: p.orderId, pauseId: p.pauseId })}
                          disabled={rejectPause.isPending || !rejectPauseReason.trim()}
                          className="btn-danger text-xs px-3 py-1"
                        >
                          {rejectPause.isPending ? 'Rejecting…' : 'Confirm Reject (resumes the job)'}
                        </button>
                        <button onClick={() => setRejectingPauseId(null)} className="btn-secondary text-xs px-3 py-1">Cancel</button>
                      </div>
                    </div>
                  ) : correctingPauseId === p.pauseId ? (
                    <div className="space-y-1.5">
                      <label className="input-label">When did work actually stop? (earlier than the recorded time)</label>
                      <input
                        type="datetime-local"
                        value={correctTime}
                        onChange={(e) => setCorrectTime(e.target.value)}
                        className="input-field text-xs"
                      />
                      <input
                        value={correctReason}
                        onChange={(e) => setCorrectReason(e.target.value)}
                        placeholder="Why the recorded time is being corrected (required)"
                        className="input-field text-xs"
                      />
                      {correctPause.isError && (
                        <p className="text-[11px] text-red-600">{correctPause.error instanceof Error ? correctPause.error.message : 'Failed'}</p>
                      )}
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => correctPause.mutate({ orderId: p.orderId, pauseId: p.pauseId })}
                          disabled={correctPause.isPending || !correctTime || !correctReason.trim()}
                          className="btn-primary text-xs px-3 py-1"
                        >
                          {correctPause.isPending ? 'Saving…' : 'Save corrected time (audited)'}
                        </button>
                        <button onClick={() => setCorrectingPauseId(null)} className="btn-secondary text-xs px-3 py-1">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        onClick={() => approvePause.mutate({ orderId: p.orderId, pauseId: p.pauseId })}
                        disabled={approvePause.isPending}
                        className="btn-success text-xs px-3 py-1"
                      >
                        {approvePause.isPending ? 'Approving…' : 'Approve'}
                      </button>
                      <button onClick={() => { setRejectingPauseId(p.pauseId); setCorrectingPauseId(null); }} className="btn-secondary text-xs px-3 py-1">
                        Reject
                      </button>
                      <button onClick={() => { setCorrectingPauseId(p.pauseId); setRejectingPauseId(null); }} className="btn-secondary text-xs px-3 py-1">
                        Adjust start time
                      </button>
                      {approvePause.isError && (
                        <p className="text-[11px] text-red-600">{approvePause.error instanceof Error ? approvePause.error.message : 'Failed'}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}

          {/* CR-2026-068 — assign ONE technician to all approved orders in one action */}
          {canManageOrders && orders.filter((o) => o.status === 'APPROVED').length >= 2 && (
            <div className="mb-4 pb-4 border-b border-slate-100">
              {!bulkAssignOpen ? (
                <button onClick={() => setBulkAssignOpen(true)} className="btn-secondary text-xs">
                  Assign all {orders.filter((o) => o.status === 'APPROVED').length} approved orders to one technician
                </button>
              ) : (
                <div className="space-y-2">
                  <label className="input-label">One technician for all {orders.filter((o) => o.status === 'APPROVED').length} approved orders</label>
                  <div className="flex items-end gap-2">
                    <div className="w-56">
                      <SearchableSelect
                        value={bulkTechId}
                        onChange={setBulkTechId}
                        placeholder="Search technician…"
                        emptyText="No technicians"
                        options={(techsQuery.data ?? []).map((t) => ({ value: t.id, label: `${t.employeeCode} — ${t.userAccount.fullName}` }))}
                      />
                    </div>
                    <button onClick={() => assignAll.mutate({ technicianId: bulkTechId })} disabled={!bulkTechId || assignAll.isPending} className="btn-primary text-xs">
                      {assignAll.isPending ? 'Assigning…' : 'Assign all'}
                    </button>
                    <button onClick={() => { setBulkAssignOpen(false); setBulkTechId(''); setWorkloadWarning(null); }} className="btn-secondary text-xs">Cancel</button>
                  </div>
                  <p className="text-[10px] text-slate-400">Each order gets a compatible free bay automatically.</p>
                  {/* CR-2026-100 — the workload warning: judgement, not a wall. */}
                  {workloadWarning?.scope === 'all' ? (
                    <div className="rounded border border-amber-300 bg-amber-50 p-2 space-y-1.5">
                      <p className="text-xs text-amber-900">{workloadWarning.message}</p>
                      <button
                        onClick={() => assignAll.mutate({ technicianId: bulkTechId, acknowledgeWorkload: true })}
                        disabled={assignAll.isPending}
                        className="btn-primary text-xs"
                      >
                        Assign anyway (recorded)
                      </button>
                    </div>
                  ) : (
                    assignAll.isError && <p className="text-xs text-red-600">{assignAll.error instanceof Error ? assignAll.error.message : 'Failed to assign all'}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {orders.length === 0 && !showServicePicker ? (
            <p className="text-sm text-slate-500">No service orders created yet.</p>
          ) : orders.length === 0 ? null : (
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
                      {/* CR-2026-071 — edit / delete before work is assigned */}
                      {canManageOrders && ['DRAFT', 'APPROVED'].includes(order.status) && (
                        <>
                          <button
                            onClick={() => {
                              setEditOrderId(editOrderId === order.id ? null : order.id);
                              setEditPickedCodes(order.items.map((it) => it.serviceType.code));
                            }}
                            className="btn-secondary text-xs py-1 px-2"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => { if (window.confirm('Delete this service order?')) deleteOrder.mutate(order.id); }}
                            disabled={deleteOrder.isPending}
                            className="btn-secondary text-xs py-1 px-2 text-red-600"
                          >
                            Delete
                          </button>
                        </>
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
                      {/* CR-2026-068 — edit assignment before work starts */}
                      {order.status === 'ASSIGNED' && canManageOrders && (
                        <button
                          onClick={() => {
                            const primary = order.assignments.find((a) => a.isPrimary) ?? order.assignments[0];
                            setReassignOrderId(reassignOrderId === order.id ? null : order.id);
                            setReassignTechId(primary?.technician.id ?? '');
                          }}
                          className="btn-secondary text-xs py-1 px-2"
                        >
                          Reassign
                        </button>
                      )}
                      {/* CR-2026-011 pause/resume/rework (dedicated endpoints) */}
                      {order.status === 'IN_PROGRESS' && (
                        <button onClick={() => { setReworkFormOrderId(null); setPauseFormOrderId(pauseFormOrderId === order.id ? null : order.id); }} className="btn-secondary text-xs py-1 px-2">
                          {/* CR-2026-100 §7 — an advisor/manager recording the stop
                              for the technician; the history says who entered it. */}
                          Pause on behalf
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
                      {/* CR-2026-100 §18 — the shared hold story + retroactive correction. */}
                      {canManageOrders && ['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER'].includes(order.status) && (
                        <button
                          onClick={() => setHoldHistoryOrderId(holdHistoryOrderId === order.id ? null : order.id)}
                          className="btn-secondary text-xs py-1 px-2"
                        >
                          Hold details
                        </button>
                      )}
                    </div>
                  </div>

                  {/* CR-2026-071 — edit the order's services (before work is assigned) */}
                  {editOrderId === order.id && (
                    <div className="card mb-3 border-blue-200 bg-blue-50">
                      <div className="card-body space-y-3">
                        <h3 className="text-xs font-semibold text-slate-900">Edit services</h3>
                        {serviceTypesQuery.isLoading ? (
                          <p className="text-xs text-slate-500">Loading services…</p>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto">
                            {(serviceTypesQuery.data ?? []).map((st) => {
                              const checked = editPickedCodes.includes(st.code);
                              return (
                                <label key={st.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) =>
                                      setEditPickedCodes((prev) =>
                                        e.target.checked ? [...prev, st.code] : prev.filter((c) => c !== st.code),
                                      )
                                    }
                                  />
                                  <span>{st.name}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                        {updateOrder.isError && <p className="text-xs text-red-600">{updateOrder.error instanceof Error ? updateOrder.error.message : 'Failed to save'}</p>}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => updateOrder.mutate({ orderId: order.id, codes: editPickedCodes })}
                            disabled={editPickedCodes.length === 0 || updateOrder.isPending}
                            className="btn-primary text-xs py-1 px-3"
                          >
                            {updateOrder.isPending ? 'Saving…' : `Save${editPickedCodes.length ? ` (${editPickedCodes.length})` : ''}`}
                          </button>
                          <button onClick={() => { setEditOrderId(null); setEditPickedCodes([]); }} className="btn-secondary text-xs py-1 px-3">Cancel</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* CR-2026-068 — reassign form (edit the technician before work starts) */}
                  {reassignOrderId === order.id && (
                    <div className="card mb-3 border-blue-200 bg-blue-50">
                      <div className="card-body space-y-2">
                        <h3 className="text-xs font-semibold text-slate-900">Reassign technician</h3>
                        <div className="flex items-end gap-2">
                          <div className="w-56">
                            <SearchableSelect
                              value={reassignTechId}
                              onChange={setReassignTechId}
                              placeholder="Search technician…"
                              emptyText="No technicians"
                              options={(techsQuery.data ?? []).map((t) => ({ value: t.id, label: `${t.employeeCode} — ${t.userAccount.fullName}` }))}
                            />
                          </div>
                          <button
                            onClick={() => {
                              const primary = order.assignments.find((a) => a.isPrimary) ?? order.assignments[0];
                              if (primary) reassign.mutate({ orderId: order.id, assignmentId: primary.id, technicianId: reassignTechId });
                            }}
                            disabled={!reassignTechId || reassign.isPending}
                            className="btn-primary text-xs"
                          >
                            {reassign.isPending ? 'Saving…' : 'Save'}
                          </button>
                          <button onClick={() => setReassignOrderId(null)} className="btn-secondary text-xs">Cancel</button>
                        </div>
                        {reassign.isError && <p className="text-xs text-red-600">{reassign.error instanceof Error ? reassign.error.message : 'Failed to reassign'}</p>}
                      </div>
                    </div>
                  )}

                  {/* Pause reason form */}
                  {pauseFormOrderId === order.id && (
                    <div className="card mb-3 border-orange-200 bg-orange-50">
                      <div className="card-body space-y-3">
                        <h3 className="text-xs font-semibold text-slate-900">Pause work on behalf of the technician</h3>
                        {/* CR-2026-100 §7 — recorded as entered by you, never as the
                            technician's own press; effective from this moment. If the
                            true stop was earlier, use "Adjust start time" afterwards. */}
                        <p className="text-[11px] text-orange-800">
                          Recorded as entered by you on the technician’s behalf, effective now. If work actually
                          stopped earlier, adjust the start time after saving.
                        </p>
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

                  {/* CR-2026-100 §18 — hold ledger: who reported, who entered it,
                      who acknowledged, effective from when; corrections in the open. */}
                  {holdHistoryOrderId === order.id && (
                    <div className="card mb-3 border-slate-200">
                      <div className="card-body space-y-2">
                        <h3 className="text-xs font-semibold text-slate-900">Hold details</h3>
                        {holdHistoryQuery.isLoading && <p className="text-xs text-slate-500">Loading…</p>}
                        {holdHistoryQuery.isError && (
                          <p className="text-xs text-red-600">
                            {holdHistoryQuery.error instanceof Error ? holdHistoryQuery.error.message : 'Failed to load'}
                          </p>
                        )}
                        {(holdHistoryQuery.data ?? []).map((p) => {
                          const fmt = (iso: string) =>
                            new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                          return (
                            <div key={p.id} className="rounded border border-slate-100 bg-slate-50 p-2 text-xs text-slate-700 space-y-0.5">
                              <p className="font-semibold">
                                {PAUSE_REASONS.find((r) => r.value === p.reasonCode)?.label ?? p.reasonCode}
                                {' · '}
                                {fmt(p.startedAt)} → {p.endedAt ? fmt(p.endedAt) : 'still stopped'}
                              </p>
                              {p.technicianName && <p>Technician: {p.technicianName}</p>}
                              {p.enteredOnBehalf && p.recordedByName && <p>Recorded by: {p.recordedByName} (on the technician’s behalf)</p>}
                              {p.approvalStatus === 'PENDING' && <p className="text-amber-700">Awaiting acknowledgement</p>}
                              {p.approvalStatus === 'APPROVED' && p.reviewedByName && p.reviewedAt && (
                                <p className="text-emerald-700">
                                  Approved by {p.reviewedByName} at {fmt(p.reviewedAt)} · effective from {fmt(p.startedAt)}
                                </p>
                              )}
                              {p.approvalStatus === 'REJECTED' && (
                                <p className="text-red-700">Rejected{p.reviewedByName ? ` by ${p.reviewedByName}` : ''}{p.reviewNotes ? `: ${p.reviewNotes}` : ''}</p>
                              )}
                              {p.originalStartedAt && (
                                <p className="text-slate-500">
                                  Corrected{p.correctedByName ? ` by ${p.correctedByName}` : ''} — originally recorded {fmt(p.originalStartedAt)}
                                  {p.correctionReason ? ` (${p.correctionReason})` : ''}
                                </p>
                              )}
                              {p.notes && <p className="italic text-slate-500">“{p.notes}”</p>}
                              {/* Retroactive correction on the open interval (§8). */}
                              {!p.endedAt && canManageOrders && (
                                correctingPauseId === p.id ? (
                                  <div className="space-y-1.5 pt-1">
                                    <input type="datetime-local" value={correctTime} onChange={(e) => setCorrectTime(e.target.value)} className="input-field text-xs" />
                                    <input
                                      value={correctReason}
                                      onChange={(e) => setCorrectReason(e.target.value)}
                                      placeholder="Why the recorded time is being corrected (required)"
                                      className="input-field text-xs"
                                    />
                                    {correctPause.isError && (
                                      <p className="text-[11px] text-red-600">{correctPause.error instanceof Error ? correctPause.error.message : 'Failed'}</p>
                                    )}
                                    <div className="flex gap-1.5">
                                      <button
                                        onClick={() => correctPause.mutate({ orderId: order.id, pauseId: p.id })}
                                        disabled={correctPause.isPending || !correctTime || !correctReason.trim()}
                                        className="btn-primary text-xs px-3 py-1"
                                      >
                                        {correctPause.isPending ? 'Saving…' : 'Save corrected time (audited)'}
                                      </button>
                                      <button onClick={() => setCorrectingPauseId(null)} className="btn-secondary text-xs px-3 py-1">Cancel</button>
                                    </div>
                                  </div>
                                ) : (
                                  <button onClick={() => setCorrectingPauseId(p.id)} className="text-[11px] text-blue-700 hover:underline">
                                    Adjust start time (earlier only)
                                  </button>
                                )
                              )}
                            </div>
                          );
                        })}
                        {holdHistoryQuery.isSuccess && (holdHistoryQuery.data ?? []).length === 0 && (
                          <p className="text-xs text-slate-500">No holds recorded on this job.</p>
                        )}
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
                    {order.items.map((item) => {
                      const qualifier = qualifierSummary(item);
                      return (
                        <div key={item.id} className="flex items-center justify-between text-xs">
                          <span className="text-slate-700">
                            {item.serviceType.name}
                            {qualifier && (
                              <span className="ml-1.5 badge bg-slate-100 text-slate-600 text-[10px]">
                                {qualifier}
                              </span>
                            )}
                          </span>
                          <span className="text-slate-400">
                            {item.estimateMinutes != null ? `~${item.estimateMinutes} min` : ''}
                            {item.actualMinutes != null ? ` (actual: ${item.actualMinutes} min)` : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* CR-2026-092 — qualifiers on the lines that need them, and the
                      standard those answers produce */}
                  <ServiceQualifiers
                    orderId={order.id}
                    items={order.items}
                    invalidateKeys={[['service-orders', ticket.serviceVisit.id]]}
                  />

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
                      {/* CR-2026-035 — recommended technicians (advisory; staff still confirm below) */}
                      {recommendationsQuery.data && recommendationsQuery.data.technicians.length > 0 && (
                        <div>
                          <div className="input-label">Recommended</div>
                          <div className="space-y-1">
                            {recommendationsQuery.data.technicians.slice(0, 5).map((rt, idx) => (
                              <div key={rt.technicianId} className={`flex items-center justify-between rounded px-2 py-1 text-xs border ${idx === 0 ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200'}`}>
                                <span className="text-slate-700">
                                  {idx === 0 ? '★ ' : ''}{rt.employeeCode} — {rt.fullName}
                                  <span className="text-slate-400"> · load {rt.openAssignments} · {rt.shiftStatus.replace(/_/g, ' ').toLowerCase()} · score {rt.score}</span>
                                </span>
                                <button
                                  onClick={() => { setAssignTechId(rt.technicianId); const bay = recommendationsQuery.data!.compatibleBays[0]; if (bay) setAssignBayId(bay.id); }}
                                  className="btn-secondary text-[10px] py-0.5 px-1.5"
                                >Use</button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {recommendationsQuery.data && recommendationsQuery.data.technicians.length === 0 && (
                        <p className="text-[11px] text-amber-600">No active technicians match this order&apos;s required skills.</p>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="input-label">Technician *</label>
                          <SearchableSelect
                            value={assignTechId}
                            onChange={setAssignTechId}
                            placeholder="Search technician…"
                            emptyText="No technicians"
                            options={(techsQuery.data ?? []).map((t) => ({
                              value: t.id,
                              label: `${t.employeeCode} — ${t.userAccount.fullName}`,
                            }))}
                          />
                        </div>
                        <div>
                          <label className="input-label">Bay (optional)</label>
                          <SearchableSelect
                            value={assignBayId}
                            onChange={setAssignBayId}
                            placeholder="Auto-assign a free bay…"
                            emptyText="No compatible bays"
                            options={[
                              { value: '', label: 'Auto — first free compatible bay' },
                              ...(recommendationsQuery.data?.compatibleBays ?? []).map((b) => ({
                                value: b.id,
                                label: b.code,
                                sublabel: b.bayType,
                              })),
                            ]}
                          />
                          <p className="text-[10px] text-slate-400 mt-1">Leave blank to auto-assign a free compatible bay.</p>
                        </div>
                      </div>
                      {/* CR-2026-100 — the workload warning: judgement, not a wall. */}
                      {workloadWarning?.scope === 'one' && workloadWarning.orderId === order.id ? (
                        <div className="rounded border border-amber-300 bg-amber-50 p-2 space-y-1.5">
                          <p className="text-xs text-amber-900">{workloadWarning.message}</p>
                          <button
                            onClick={() => assignOrder.mutate({ orderId: order.id, acknowledgeWorkload: true })}
                            disabled={assignOrder.isPending}
                            className="btn-primary text-xs"
                          >
                            Assign anyway (recorded)
                          </button>
                        </div>
                      ) : (
                        assignOrder.isError && <p className="text-xs text-red-600">{assignOrder.error instanceof Error ? assignOrder.error.message : 'Failed'}</p>
                      )}
                      <div className="flex gap-2">
                        <button onClick={() => assignOrder.mutate({ orderId: order.id })} disabled={!assignTechId || assignOrder.isPending} className="btn-primary text-xs">
                          {assignOrder.isPending ? 'Assigning...' : 'Assign'}
                        </button>
                        <button onClick={() => { setAssigningOrderId(null); setWorkloadWarning(null); }} className="btn-secondary text-xs">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Inspections (CR-2026-093) — one click from the queue into the workspace */}
      <div className="card mb-6">
        <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Inspections &amp; Job Sheet</h2></div>
        <div className="card-body space-y-2">
          {(inspectionsQuery.data?.items ?? []).length > 0 && (
            <div className="space-y-2">
              {inspectionsQuery.data!.items.map((insp) => (
                <Link key={insp.id} href={`/inspections/${insp.id}`} className="flex items-center justify-between gap-2 border border-slate-200 rounded-md px-3 py-2 hover:border-blue-300">
                  <span className="font-mono text-xs font-semibold text-blue-600">{insp.inspectionNumber}</span>
                  <span className={`badge text-[10px] ${insp.kind === 'PRE_INSPECTION' ? 'bg-cyan-50 text-cyan-700' : 'bg-indigo-50 text-indigo-700'}`}>
                    {insp.kind === 'PRE_INSPECTION' ? 'Pre-Inspection' : 'Vehicle'}
                  </span>
                  <StatusBadge status={insp.status} />
                </Link>
              ))}
            </div>
          )}
          {canInspect && (
            <>
              {startInspection.isError && <p className="text-xs text-red-600">{startInspection.error instanceof Error ? startInspection.error.message : 'Failed to start inspection'}</p>}
              <div className="flex flex-wrap gap-2">
                <button onClick={() => openOrStart('VEHICLE_INSPECTION')} disabled={startInspection.isPending} className="btn-secondary text-xs">
                  {startInspection.isPending ? 'Opening…' : 'Vehicle Inspection'}
                </button>
                <button onClick={() => openOrStart('PRE_INSPECTION')} disabled={startInspection.isPending} className="btn-secondary text-xs">
                  Pre-Inspection
                </button>
                <Link href={`/inspections/job-sheet/${ticket!.serviceVisit.id}`} className="btn-secondary text-xs">
                  Job Sheet
                </Link>
              </div>
            </>
          )}
        </div>
      </div>

      {/* CR-2026-101 — typed operational notes: concern / advisor / manager /
          technician / safety / data reports, distinguishable, resolvable. */}
      <div className="mb-6">
        <VisitNotesCard
          visitId={ticket!.serviceVisit.id}
          addableKinds={
            user?.roleCode === 'ADMIN'
              ? ['CUSTOMER_CONCERN', 'ADVISOR', 'MANAGER', 'SAFETY', 'DATA_REPORT']
              : user?.roleCode === 'SERVICE_ADVISOR'
                ? ['CUSTOMER_CONCERN', 'ADVISOR', 'SAFETY', 'DATA_REPORT']
                : ['TECHNICIAN', 'SAFETY', 'DATA_REPORT']
          }
          canResolve={canManageOrders}
          title="Notes & Instructions"
        />
      </div>

      {/* CR-2026-096 — customer contact via the shared composer + history */}
      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Customer Communication</h2>
          <div className="flex items-center gap-1.5">
            <button onClick={openComposer} className="btn-primary text-xs py-1 px-3">Contact Customer</button>
            <button onClick={() => logCall.mutate()} disabled={logCall.isPending} className="btn-secondary text-xs py-1 px-2" title="Record that the customer was called — nothing is sent">
              {logCall.isPending ? 'Logging…' : 'Log Call'}
            </button>
          </div>
        </div>
        <div className="card-body p-0">
          {logCall.isError && <p className="text-xs text-red-600 px-4 pt-3">{logCall.error instanceof Error ? logCall.error.message : 'Failed to log call'}</p>}
          <CommunicationHistory serviceVisitId={sv.id} bare />
        </div>
      </div>

      {/* CR-2026-085 — one prominent button; the details live in a modal. */}
      {showCompletionSection && (
        <div className="card mb-6 border-emerald-200">
          <div className="card-body flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-emerald-900">
                {sv.status === 'QC' ? 'Work finished — awaiting quality check' : 'Ready for collection'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Closing takes one step. Mileage out and notes are optional.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {sv.status === 'READY_FOR_PICKUP' && (
                <button
                  onClick={() =>
                    setComposerCtx({
                      reason: 'PICKUP_READY',
                      customerId: sv.customer.id,
                      vehicleId: sv.vehicle.id,
                      serviceVisitId: sv.id,
                    })
                  }
                  className="btn-primary text-sm px-4 py-2.5"
                >
                  Notify Customer
                </button>
              )}
              <button onClick={() => setShowCompletion(true)} className="btn-success text-sm px-5 py-2.5 font-semibold">
                Close Visit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CR-2026-096 — shared customer notification composer */}
      {composerCtx && (
        <CustomerNotificationComposer
          open
          context={composerCtx}
          allowReasonChoice={composerCtx.reason !== 'PICKUP_READY'}
          onClose={() => setComposerCtx(null)}
          onSent={() => queryClient.invalidateQueries({ queryKey: ['notification-history'] })}
        />
      )}

      {/* Close-out modal */}
      {showCompletion && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-visit-title"
          onClick={() => !completeVisit.isPending && setShowCompletion(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 id="close-visit-title" className="text-base font-semibold text-slate-900">Close Visit</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {ticket.ticketNumber} · {sv.customer.firstName} {sv.customer.lastName} · {sv.vehicle.plateNumber}
              </p>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="input-label">Mileage Out <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  type="number"
                  autoFocus
                  value={mileageOut}
                  onChange={(e) => setMileageOut(e.target.value)}
                  className="input-field"
                  placeholder={sv.mileageIn != null ? `e.g., ${sv.mileageIn.toLocaleString()}` : 'Optional'}
                />
                {sv.mileageIn != null && mileageOut && parseInt(mileageOut, 10) < sv.mileageIn && (
                  <p className="text-[11px] text-red-500 mt-1">Must be ≥ mileage in ({sv.mileageIn.toLocaleString()})</p>
                )}
              </div>
              <div>
                <label className="input-label">Notes <span className="text-slate-400 font-normal">(optional)</span></label>
                <textarea
                  value={completionNotes}
                  onChange={(e) => setCompletionNotes(e.target.value)}
                  rows={3}
                  className="input-field"
                  placeholder="Anything worth recording about this visit"
                />
              </div>
              {completeVisit.isError && (
                <p className="text-xs text-red-600">
                  {completeVisit.error instanceof Error ? completeVisit.error.message : 'Failed to close the visit'}
                </p>
              )}
            </div>

            <div className="px-5 py-4 border-t border-slate-100 flex gap-2 justify-end">
              <button
                onClick={() => setShowCompletion(false)}
                disabled={completeVisit.isPending}
                className="btn-secondary text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => completeVisit.mutate()}
                disabled={releaseDisabled}
                className="btn-success text-sm px-5 font-semibold"
              >
                {completeVisit.isPending ? 'Closing…' : 'Close Visit'}
              </button>
            </div>
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
