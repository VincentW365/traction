'use client';

/**
 * CR-2026-103 — the Technician dashboard, restructured for the workshop.
 *
 * Two different questions, two visually separate areas:
 *   MY WORKDAY  — how is my day going? (compact personal statistics)
 *   MY JOBS     — what do I work on now / next? (operational job cards)
 *
 * The scan order is fixed: Working Now → Up Next → Waiting → Rework →
 * Awaiting QC → Completed (collapsed). Registration numbers lead every card;
 * one primary action per state; deeper detail lives in the Job Workspace
 * (progressive disclosure). The multi-job model underneath (CR-2026-100/101 —
 * one open labour segment, measured holds, acknowledged pauses) is unchanged.
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSiteId } from '../../../hooks/use-site';
import { useQueueSocket } from '../../../hooks/use-queue-socket';
import { CONFIDENCE_CLASS, CONFIDENCE_LABEL, fmtEtaWindow, type EtaView } from '../../../lib/eta-format';
import { api, ApiError } from '../../../lib/api-client';
import { useAuth } from '../../../hooks/use-auth';
import { EmptyState } from '../../../components/ui/empty-state';
import { LoadingState } from '../../../components/ui/loading-state';
import { StatusBadge } from '../../../components/status-badge';
import { PAUSE_REASONS } from '../../../lib/service-order-actions';
import { KpiStrip, type LiveKpi } from '../../../components/kpi-strip';
import { ServiceQualifiers } from '../../../components/service-qualifiers';

// CR-2026-073 — H:MM:SS for the live work timers.
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
// Static durations (no live tick) print WITHOUT seconds so they never look frozen.
function fmtMins(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtApptTime = fmtTime;

const VEHICLE_CLASS_LABEL: Record<string, string> = {
  SEDAN_CLASS: 'Sedan',
  SUV_CLASS: 'SUV',
  UNKNOWN_REQUIRES_REVIEW: 'Class not set',
};
const PRIORITY_LABEL: Record<string, string> = {
  MANUAL_OVERRIDE: 'Pinned',
  APPT_PROTECTED: 'Appt · on time',
  APPT_LATE_SOFT: 'Appt · late',
  MISSED_APPOINTMENT: 'Missed appt',
  WALKIN_FASTTRACK: 'Fast track',
  WALKIN_STANDARD: 'Walk-in',
};

/**
 * CR-2026-100 — one assignment belonging to the logged-in technician.
 * A technician legitimately holds SEVERAL jobs; the one with an open labour
 * segment is "on the clock" — at most one, the API enforces it.
 */
interface MyAssignment {
  assignmentId: string;
  orderId: string;
  orderStatus: string;
  assignmentStatus: string;
  assignmentEndedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  serviceVisitId: string;
  visitNumber: string | null;
  queueTicketId: string | null;
  ticketNumber: string | null;
  customerName: string;
  vehicle: string;
  plate: string;
  vehicleClass: string | null;
  priorityClass: string | null;
  bay: string | null;
  services: string[];
  // CR-2026-101 — anticipate + prioritise.
  expectedMinutes: number;
  // CR-2026-105b — planned time + the authoritative target completion.
  plannedMinutes: number;
  eta: EtaView;
  sourceType: string | null;
  appointmentAt: string | null;
  hasOpenRework: boolean;
  // CR-2026-103 — WHY the job came back.
  openRework: { reasonCode: string; description: string | null } | null;
  concern: string | null;
  pausedMs: number;
  myWorkMs: number;
  hasOpenSegment: boolean;
  openPause: {
    id: string;
    reasonCode: string;
    notes: string | null;
    startedAt: string;
    approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
    enteredOnBehalf: boolean;
  } | null;
}

const HELD_STATUSES = ['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER'];

type JobsFilter = 'ALL' | 'ACTIVE' | 'UP_NEXT' | 'WAITING' | 'REWORK' | 'QC' | 'DONE';
const FILTERS: Array<{ key: JobsFilter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'Active' },
  { key: 'UP_NEXT', label: 'Up Next' },
  { key: 'WAITING', label: 'Waiting' },
  { key: 'REWORK', label: 'Rework' },
  { key: 'QC', label: 'QC' },
  { key: 'DONE', label: 'Done' },
];

/* ---------------- presentation pieces ---------------- */

/** §9 — a compact workday statistic: label + strong number + optional support. */
function WorkdayStat({ label, value, tone, sub }: { label: string; value: string | number; tone: string; sub?: string }) {
  const tones: Record<string, string> = {
    emerald: 'border-l-emerald-500 text-emerald-700',
    slate: 'border-l-slate-400 text-slate-900',
    amber: 'border-l-amber-500 text-amber-700',
    red: 'border-l-red-500 text-red-700',
    violet: 'border-l-violet-500 text-violet-700',
    muted: 'border-l-slate-300 text-slate-500',
    blue: 'border-l-blue-500 text-blue-800',
  };
  return (
    <div className={`card border-l-4 px-3 py-2 min-w-[5.5rem] ${tones[tone] ?? tones.slate}`}>
      <div className="text-xl font-bold tabular-nums leading-tight">{value}</div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

/** §2 — a labelled job section with a colour cue and a light empty state. */
function JobSection({
  title,
  count,
  accent,
  emptyText,
  children,
}: {
  title: string;
  count: number;
  accent: string;
  emptyText?: string;
  children?: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 rounded-full ${accent}`} />
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
        <span className="text-xs text-slate-400">({count})</span>
      </div>
      {count === 0
        ? emptyText && <p className="text-xs text-slate-400 pl-4 pb-1">{emptyText}</p>
        : children}
    </section>
  );
}

/** §5 — registration first, always: the fastest thing to match to a car. */
function PlateHeading({ a, big = false }: { a: MyAssignment; big?: boolean }) {
  return (
    <div>
      <Link
        href={`/technician/jobs/${a.orderId}`}
        className={`font-black font-mono tracking-wide text-slate-900 hover:underline ${big ? 'text-3xl' : 'text-2xl'}`}
      >
        {a.plate}
      </Link>
      <span className="text-sm text-slate-500 ml-2">{a.vehicle}</span>
    </div>
  );
}

/** §4 context chips — small, consistent, never competing with the plate. */
function JobChips({ a }: { a: MyAssignment }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {a.appointmentAt ? (
        <span className="badge bg-blue-50 text-blue-700 text-[10px]">Appt {fmtApptTime(a.appointmentAt)}</span>
      ) : (
        a.sourceType === 'WALKIN' && <span className="badge bg-slate-100 text-slate-500 text-[10px]">Walk-in</span>
      )}
      {a.expectedMinutes > 0 && (
        <span className="badge bg-slate-100 text-slate-600 text-[10px]">~{fmtMins(a.expectedMinutes * 60000)}</span>
      )}
      {a.eta?.estimatedCompletion && !a.eta.terminal && (
        <span className={`badge text-[10px] ${a.eta.confidence ? CONFIDENCE_CLASS[a.eta.confidence] : 'bg-slate-100 text-slate-600'}`}>
          Target {fmtEtaWindow(a.eta.estimatedCompletion, a.eta.showRange)}
        </span>
      )}
      {a.priorityClass && PRIORITY_LABEL[a.priorityClass] && (
        <span className="badge bg-indigo-50 text-indigo-700 text-[10px]">{PRIORITY_LABEL[a.priorityClass]}</span>
      )}
      {a.vehicleClass && (
        <span className="badge bg-slate-100 text-slate-600 text-[10px]">{VEHICLE_CLASS_LABEL[a.vehicleClass] ?? a.vehicleClass}</span>
      )}
      {a.bay && <span className="badge bg-slate-100 text-slate-600 text-[10px]">Bay {a.bay}</span>}
    </div>
  );
}

/** §5 — the short service request, quoted, never buried. */
function ConcernLine({ a }: { a: MyAssignment }) {
  if (!a.concern) return null;
  return <p className="text-xs text-blue-900 bg-blue-50 rounded px-2 py-1">“{a.concern}”</p>;
}

/** §7 — the one secondary path into the full workspace. */
function OpenJobLink({ orderId, subtle = true }: { orderId: string; subtle?: boolean }) {
  return (
    <Link
      href={`/technician/jobs/${orderId}`}
      className={
        subtle
          ? 'inline-block text-xs font-semibold text-blue-700 hover:underline'
          : 'block text-center rounded-lg border border-blue-200 bg-blue-50 py-2 text-sm font-semibold text-blue-800 hover:border-blue-300 transition-colors'
      }
    >
      Open Job →
    </Link>
  );
}

/** CR-2026-100 §4 — the hero card's one-tap job sheet. */
function JobSheetLink({ visitId }: { visitId: string }) {
  return (
    <Link
      href={`/inspections/job-sheet/${visitId}`}
      className="block text-center rounded-lg border border-slate-200 py-2 text-sm font-semibold text-blue-700 hover:border-blue-300 transition-colors"
    >
      View Job Sheet
    </Link>
  );
}

/** CR-2026-100 §5/§18 — what the technician sees about their pause request. */
function PauseAckLine({ p }: { p: NonNullable<MyAssignment['openPause']> }) {
  if (p.approvalStatus === 'PENDING') {
    return (
      <p className="text-xs text-amber-800">
        Requested {fmtTime(p.startedAt)} — awaiting advisor/manager acknowledgement
      </p>
    );
  }
  if (p.approvalStatus === 'APPROVED') {
    return (
      <p className="text-xs text-emerald-700">
        {p.enteredOnBehalf ? 'Recorded by an advisor/manager' : 'Acknowledged'} · effective from {fmtTime(p.startedAt)}
      </p>
    );
  }
  return <p className="text-xs text-red-700">Rejected — see the advisor</p>;
}

/* ---------------- the page ---------------- */

export default function TechnicianWorkView() {
  // CR-2026-105b — refresh the moment the queue/ETA republishes (polling stays as fallback).
  const socketSiteId = useSiteId();
  useQueueSocket(socketSiteId);
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const myAssignmentsQuery = useQuery<MyAssignment[]>({
    queryKey: ['my-assignments'],
    queryFn: () => api.get('/service-orders/mine/assignments'),
    refetchInterval: 10000,
  });

  // CR-2026-101 §10 — the workday clock: real merged labour today.
  const workdayQuery = useQuery<{ todayWorkMs: number; activeSegmentStartedAt: string | null }>({
    queryKey: ['my-workday'],
    queryFn: () => api.get('/service-orders/mine/workday'),
    refetchInterval: 30000,
  });

  const assignments = myAssignmentsQuery.data ?? [];
  const openAssignments = assignments.filter((a) => !a.assignmentEndedAt);
  // CR-2026-101 §8 — a job returned for rework is its own bucket until restarted.
  const reworkJobs = openAssignments.filter((a) => a.orderStatus === 'ASSIGNED' && a.hasOpenRework);
  const readyToStart = openAssignments.filter((a) => a.orderStatus === 'ASSIGNED' && !a.hasOpenRework);
  const heldJobs = openAssignments.filter((a) => HELD_STATUSES.includes(a.orderStatus));
  const inProgress = openAssignments.filter((a) => a.orderStatus === 'IN_PROGRESS');
  // On the clock = the job with my open labour segment. The API guarantees at
  // most one; work on a second job requires an explicit switch.
  const currentJob = inProgress.find((a) => a.hasOpenSegment) ?? inProgress[0] ?? null;
  const otherInProgress = inProgress.filter((a) => a.orderId !== currentJob?.orderId);
  // CR-2026-101 §8 — QC and done-today are different answers to "where is it?".
  const awaitingQc = assignments.filter((a) => a.assignmentEndedAt && a.orderStatus === 'QC');
  const finishedToday = assignments.filter(
    (a) => a.assignmentEndedAt && ['READY_TO_INVOICE', 'CLOSED'].includes(a.orderStatus),
  );
  const waitingParts = heldJobs.filter((a) => a.orderStatus === 'WAITING_PARTS').length;
  const waitingCustomer = heldJobs.filter((a) => a.orderStatus === 'WAITING_CUSTOMER').length;

  const [filter, setFilter] = useState<JobsFilter>('ALL');
  const show = (key: Exclude<JobsFilter, 'ALL'>) => filter === 'ALL' || filter === key;

  const [pauseReason, setPauseReason] = useState<string>(PAUSE_REASONS[0].value);
  const [pauseNotes, setPauseNotes] = useState('');
  const [showPause, setShowPause] = useState(false);

  // CR-2026-100 — the switch dialog: starting job B while on the clock for job A.
  const [switchFor, setSwitchFor] = useState<{ orderId: string; assignmentId: string; activeTicket: string } | null>(null);
  const [switchReason, setSwitchReason] = useState<string>(PAUSE_REASONS[0].value);
  const [switchNotes, setSwitchNotes] = useState('');

  const invalidateWork = () => {
    queryClient.invalidateQueries({ queryKey: ['my-assignments'] });
    queryClient.invalidateQueries({ queryKey: ['work-timing'] });
    queryClient.invalidateQueries({ queryKey: ['my-workday'] });
  };

  const startMutation = useMutation({
    mutationFn: ({ orderId, assignmentId, hold }: { orderId: string; assignmentId: string; hold?: { reasonCode: string; notes?: string } }) =>
      api.post(`/service-orders/${orderId}/assignments/${assignmentId}/start`, hold ? { holdReasonCode: hold.reasonCode, ...(hold.notes ? { holdNotes: hold.notes } : {}) } : {}),
    onSuccess: () => { invalidateWork(); setSwitchFor(null); setSwitchNotes(''); },
    onError: (err, vars) => {
      // 409 with the active job → open the switch dialog instead of a dead error.
      if (err instanceof ApiError && (err.body as { code?: string })?.code === 'ACTIVE_WORK_ELSEWHERE') {
        const active = ((err.body as { activeJobs?: Array<{ ticketNumber: string | null; plate: string }> }).activeJobs ?? [])[0];
        setSwitchFor({
          orderId: vars.orderId,
          assignmentId: vars.assignmentId,
          activeTicket: active?.ticketNumber ?? active?.plate ?? 'your current job',
        });
      }
    },
  });
  const pauseMutation = useMutation({
    mutationFn: (orderId: string) =>
      api.post(`/service-orders/${orderId}/pause`, {
        reasonCode: pauseReason,
        ...(pauseNotes.trim() ? { notes: pauseNotes.trim() } : {}),
      }),
    onSuccess: () => { invalidateWork(); setShowPause(false); setPauseNotes(''); },
  });
  const resumeMutation = useMutation({
    mutationFn: (orderId: string) => api.post(`/service-orders/${orderId}/resume`, {}),
    onSuccess: invalidateWork,
  });
  const readyForQcMutation = useMutation({
    mutationFn: (orderId: string) => api.post(`/service-orders/${orderId}/ready-for-qc`, {}),
    onSuccess: invalidateWork,
  });

  // CR-2026-073 — live work timers.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const workTimingQuery = useQuery<{
    startedAt: string | null; completedAt: string | null; status: string; pausedMs: number;
    waitingPartsMs: number; waitingCustomerMs: number; otherPausedMs: number;
    openPauseStartedAt: string | null; openPauseReason: string | null; openPauseNotes: string | null;
    openPauseApprovalStatus: string | null;
  }>({
    queryKey: ['work-timing', currentJob?.orderId],
    queryFn: () => api.get(`/service-orders/${currentJob!.orderId}/work-timing`),
    enabled: !!currentJob,
    refetchInterval: 15000,
  });

  // CR-2026-088 — live KPI for the job in hand.
  const kpiQuery = useQuery<LiveKpi>({
    queryKey: ['kpi-live', currentJob?.orderId],
    queryFn: () => api.get(`/kpi/orders/${currentJob!.orderId}/live`),
    enabled: !!currentJob,
    refetchInterval: 30000,
  });

  // Timer math for the on-the-clock job (§6 — JOB timing, not workday timing).
  const timing = workTimingQuery.data;
  const startedMs = timing?.startedAt ? new Date(timing.startedAt).getTime() : null;
  const openPauseMs = timing?.openPauseStartedAt ? now - new Date(timing.openPauseStartedAt).getTime() : 0;
  const elapsedMs = startedMs ? now - startedMs : 0;
  const workingMs = startedMs ? elapsedMs - (timing?.pausedMs ?? 0) - openPauseMs : 0;
  const expectedMs = (currentJob?.expectedMinutes ?? 0) * 60000;
  const overExpected = !!startedMs && expectedMs > 0 && elapsedMs > expectedMs;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  // CR-2026-118 §6 — the whole recorded name. Taking the first word produced
  // "Good morning, J." for every technician stored as initial-plus-surname.
  const displayName = user?.fullName?.trim() ?? '';
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  if (myAssignmentsQuery.isLoading) {
    return (
      <div className="min-h-screen bg-slate-100 p-4">
        <div className="max-w-2xl mx-auto">
          <LoadingState message="Loading your assignments..." />
        </div>
      </div>
    );
  }

  // The switch dialog, rendered inside whichever "start" card triggered it.
  const switchPanel = (a: { orderId: string; assignmentId: string }) =>
    switchFor && switchFor.orderId === a.orderId ? (
      <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
        <p className="text-sm font-semibold text-amber-900">
          You’re on the clock for {switchFor.activeTicket}.
        </p>
        <p className="text-xs text-amber-800">Why is that job stopping?</p>
        <select value={switchReason} onChange={(e) => setSwitchReason(e.target.value)} className="input-field">
          {PAUSE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <textarea
          value={switchNotes}
          onChange={(e) => setSwitchNotes(e.target.value)}
          rows={2}
          placeholder={switchReason === 'OTHER' ? 'Briefly, what happened?' : 'Note (optional)'}
          className="input-field text-sm"
        />
        <div className="flex gap-2">
          <button
            onClick={() => startMutation.mutate({ orderId: a.orderId, assignmentId: a.assignmentId, hold: { reasonCode: switchReason, notes: switchNotes.trim() || undefined } })}
            disabled={startMutation.isPending}
            className="btn-primary flex-1 py-3 font-semibold rounded-lg"
          >
            {startMutation.isPending ? 'Switching…' : 'HOLD IT & SWITCH'}
          </button>
          <button onClick={() => { setSwitchFor(null); setSwitchNotes(''); }} className="btn-secondary py-3 px-4 rounded-lg">Cancel</button>
        </div>
      </div>
    ) : null;

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* ---- Technician header (§3) ---- */}
        <div>
          {/* CR-2026-118 §6 — a readable name from the authenticated account, never a
              fragment of one. When no name is recorded the heading still reads as a
              welcome rather than as a missing value. */}
          <h1 className="text-xl font-bold text-slate-900">
            {displayName ? `Welcome back, ${displayName}` : 'Welcome to your Technician Workspace'}
          </h1>
          <p className="text-sm text-slate-600">{greeting} · Your Service Centre workspace</p>
          <p className="text-xs text-slate-500">
            <span className="font-semibold text-slate-700">Technician</span> · Service Centre · {today}
          </p>
        </div>

        {/* ================= MY WORKDAY (§1/§9) ================= */}
        <section>
          <h2 className="text-sm font-bold text-slate-800 mb-2">My Workday</h2>
          <div className="flex flex-wrap gap-2">
            <WorkdayStat label="Active" value={currentJob ? 1 : 0} tone="emerald" />
            <WorkdayStat label="Up Next" value={readyToStart.length} tone="slate" />
            <WorkdayStat
              label="Waiting"
              value={heldJobs.length}
              tone="amber"
              sub={
                heldJobs.length > 0
                  ? [waitingParts ? `${waitingParts} parts` : '', waitingCustomer ? `${waitingCustomer} customer` : '']
                      .filter(Boolean)
                      .join(' · ') || undefined
                  : undefined
              }
            />
            <WorkdayStat label="Rework" value={reworkJobs.length} tone="red" />
            <WorkdayStat label="QC" value={awaitingQc.length} tone="violet" />
            <WorkdayStat label="Done" value={finishedToday.length} tone="muted" />
            <WorkdayStat
              label="Work Time"
              value={workdayQuery.data ? fmtMins(workdayQuery.data.todayWorkMs) : '—'}
              tone="blue"
              sub={workdayQuery.data?.activeSegmentStartedAt ? 'clock running' : undefined}
            />
          </div>
        </section>

        {myAssignmentsQuery.isError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Could not load your work.{' '}
            {myAssignmentsQuery.error instanceof Error ? myAssignmentsQuery.error.message : ''}
          </div>
        )}

        {/* ================= MY JOBS (§2) ================= */}
        <div className="border-t border-slate-200 pt-4">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <h2 className="text-sm font-bold text-slate-800">My Jobs</h2>
            {/* §14 — simple filtering; the default order already prioritises work. */}
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5 overflow-x-auto">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                    filter === f.key ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-5">
            {/* ---- WORKING NOW (§3) — the most important card on the page ---- */}
            {show('ACTIVE') && (
              <JobSection title="Working Now" count={currentJob ? 1 : 0} accent="bg-emerald-500">
                {currentJob ? (
                  <div className="card overflow-hidden border-emerald-200 shadow-md">
                    <div className="bg-emerald-600 text-white px-5 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          {/* §5 — registration first, biggest thing on the card. */}
                          <Link href={`/technician/jobs/${currentJob.orderId}`} className="text-3xl font-black font-mono tracking-wide hover:underline">
                            {currentJob.plate}
                          </Link>
                          <div className="text-sm text-emerald-100 mt-0.5">{currentJob.vehicle}</div>
                          <div className="text-xs text-emerald-200 mt-0.5">
                            {currentJob.customerName}
                            {currentJob.ticketNumber ? ` · ${currentJob.ticketNumber}` : ''}
                            {currentJob.bay ? ` · Bay ${currentJob.bay}` : ''}
                          </div>
                        </div>
                        <span className="badge bg-white/20 text-white text-[10px] font-bold shrink-0">WORKING</span>
                      </div>
                    </div>

                    <div className="card-body space-y-3">
                      <ConcernLine a={currentJob} />
                      <div>
                        <p className="text-sm font-medium text-slate-900">
                          {currentJob.services.join(', ') || 'No services recorded'}
                        </p>
                        <JobChips a={currentJob} />
                        <ServiceQualifiers
                          orderId={currentJob.orderId}
                          invalidateKeys={[['kpi-live', currentJob.orderId]]}
                        />
                      </div>

                      {/* §6 — JOB timing lives here, on the job. */}
                      {startedMs ? (
                        <>
                          <div className="grid grid-cols-2 gap-3">
                            <div className={`rounded-xl border p-3 text-center ${overExpected ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}>
                              <div className="input-label">Elapsed{overExpected ? ' · over expected' : ''}</div>
                              <div className={`text-2xl font-bold font-mono tabular-nums mt-0.5 ${overExpected ? 'text-amber-700' : 'text-slate-900'}`}>{fmtClock(elapsedMs)}</div>
                            </div>
                            <div className="rounded-xl border p-3 text-center bg-emerald-50 border-emerald-200">
                              <div className="input-label">Working</div>
                              <div className="text-2xl font-bold font-mono tabular-nums mt-0.5 text-emerald-700">{fmtClock(workingMs)}</div>
                            </div>
                          </div>
                          {timing?.startedAt && (
                            <p className="text-[11px] text-slate-400 text-center">
                              Started {fmtTime(timing.startedAt)}
                              {currentJob.expectedMinutes > 0 ? ` · expected ${fmtMins(expectedMs)}` : ''}
                            </p>
                          )}
                          {currentJob.eta?.estimatedCompletion && !currentJob.eta.terminal && (
                            <p className="text-[11px] text-center">
                              <span className="text-slate-500">
                                Target <span className="font-medium text-slate-700">{fmtEtaWindow(currentJob.eta.estimatedCompletion, currentJob.eta.showRange)}</span>
                              </span>
                              {currentJob.eta.confidence && (
                                <span className={`ml-2 px-1.5 py-0.5 rounded font-medium ${CONFIDENCE_CLASS[currentJob.eta.confidence]}`}>
                                  {CONFIDENCE_LABEL[currentJob.eta.confidence]}
                                </span>
                              )}
                            </p>
                          )}
                          <KpiStrip kpi={kpiQuery.data} />
                        </>
                      ) : (
                        <div className="text-center"><StatusBadge status={currentJob.orderStatus} /></div>
                      )}

                      {/* Actions — pause + finish are the two real choices here. */}
                      {showPause ? (
                        <div className="space-y-2 rounded-lg border border-orange-200 bg-orange-50 p-3">
                          <label className="input-label">Why is work stopping?</label>
                          <select value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} className="input-field">
                            {PAUSE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                          <textarea
                            value={pauseNotes}
                            onChange={(e) => setPauseNotes(e.target.value)}
                            rows={2}
                            placeholder={pauseReason === 'OTHER' ? 'Briefly, what happened?' : 'Note (optional)'}
                            className="input-field text-sm"
                          />
                          <p className="text-[11px] text-orange-800">
                            The clock stops the moment you confirm. An advisor/manager will acknowledge it.
                          </p>
                          {pauseMutation.isError && (
                            <p className="text-xs text-red-700">{pauseMutation.error instanceof Error ? pauseMutation.error.message : 'Failed to pause'}</p>
                          )}
                          <div className="flex gap-2">
                            <button onClick={() => pauseMutation.mutate(currentJob.orderId)} disabled={pauseMutation.isPending} className="btn-primary flex-1 py-3 font-semibold rounded-lg">
                              {pauseMutation.isPending
                                ? 'Stopping…'
                                : pauseReason === 'WAITING_PARTS' ? 'Mark Waiting for Parts' : 'Confirm Pause'}
                            </button>
                            <button onClick={() => { setShowPause(false); setPauseNotes(''); }} className="btn-secondary py-3 px-4 rounded-lg">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-2">
                          <button onClick={() => setShowPause(true)} className="btn-secondary py-3 text-sm font-semibold rounded-lg">
                            Pause / Hold-up
                          </button>
                          <button
                            onClick={() => readyForQcMutation.mutate(currentJob.orderId)}
                            disabled={readyForQcMutation.isPending}
                            className="btn-success py-3 text-sm font-bold rounded-lg active:scale-[0.98] transition-transform"
                          >
                            {readyForQcMutation.isPending ? 'Sending…' : 'FINISHED → QC'}
                          </button>
                        </div>
                      )}
                      {readyForQcMutation.isError && (
                        <p className="text-xs text-red-600 text-center">{readyForQcMutation.error instanceof Error ? readyForQcMutation.error.message : 'Failed to send to QC'}</p>
                      )}

                      {/* §3 — View Job + View Job Sheet, one tap each. */}
                      <div className="grid grid-cols-2 gap-2">
                        <OpenJobLink orderId={currentJob.orderId} subtle={false} />
                        <JobSheetLink visitId={currentJob.serviceVisitId} />
                      </div>
                    </div>
                  </div>
                ) : (
                  // §13 — a useful empty state that points at the next action.
                  <div className="card p-5 text-center">
                    <p className="text-sm text-slate-600">No job currently active.</p>
                    {readyToStart.length > 0 ? (
                      <p className="text-xs text-slate-400 mt-1">Select an assigned job below to begin.</p>
                    ) : (
                      <p className="text-xs text-slate-400 mt-1">When the front desk assigns you work it appears here.</p>
                    )}
                  </div>
                )}

                {/* Shared jobs the technician stepped off — still theirs, not on their clock. */}
                {otherInProgress.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {otherInProgress.map((a) => (
                      <div key={a.assignmentId} className="card px-4 py-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <PlateHeading a={a} />
                          <span className="badge bg-slate-100 text-slate-500 text-[10px] shrink-0">NOT ON YOUR CLOCK</span>
                        </div>
                        <p className="text-xs text-slate-500">{a.services.join(', ')} · your work so far {fmtMins(a.myWorkMs)}</p>
                        {switchPanel(a)}
                        {(!switchFor || switchFor.orderId !== a.orderId) && (
                          <div className="flex items-center justify-between gap-2">
                            <button
                              onClick={() => startMutation.mutate({ orderId: a.orderId, assignmentId: a.assignmentId })}
                              disabled={startMutation.isPending}
                              className="btn-secondary text-sm font-semibold py-2 px-4 rounded-lg"
                            >
                              Back to this job
                            </button>
                            <OpenJobLink orderId={a.orderId} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </JobSection>
            )}

            {/* ---- UP NEXT (§3) ---- */}
            {show('UP_NEXT') && (
              <JobSection
                title="Up Next"
                count={readyToStart.length}
                accent="bg-blue-500"
                emptyText="Nothing else assigned yet."
              >
                <div className="space-y-2">
                  {readyToStart.map((a) => (
                    <div key={a.assignmentId} className="card px-4 py-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <PlateHeading a={a} />
                        <span className="badge bg-blue-50 text-blue-700 text-[10px] shrink-0">UP NEXT</span>
                      </div>
                      <p className="text-sm text-slate-700">{a.services.join(', ')}</p>
                      <ConcernLine a={a} />
                      <JobChips a={a} />
                      {/* CR-2026-092 — missing qualifiers are answerable here, not a refusal on Start. */}
                      <ServiceQualifiers orderId={a.orderId} showCalculation={false} />
                      {switchPanel(a)}
                      {startMutation.isError &&
                        startMutation.variables?.assignmentId === a.assignmentId &&
                        !(startMutation.error instanceof ApiError && (startMutation.error.body as { code?: string })?.code === 'ACTIVE_WORK_ELSEWHERE') && (
                          <p className="text-xs text-red-600">{startMutation.error instanceof Error ? startMutation.error.message : 'Failed to start'}</p>
                        )}
                      {(!switchFor || switchFor.orderId !== a.orderId) && (
                        <div className="flex items-center justify-between gap-3">
                          {/* §4 — ONE primary action per state. */}
                          <button
                            onClick={() => startMutation.mutate({ orderId: a.orderId, assignmentId: a.assignmentId })}
                            disabled={startMutation.isPending}
                            className="btn-success flex-1 py-3 text-base font-bold rounded-lg active:scale-[0.98] transition-transform"
                          >
                            {startMutation.isPending && startMutation.variables?.assignmentId === a.assignmentId ? 'Starting…' : 'START WORK'}
                          </button>
                          <OpenJobLink orderId={a.orderId} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </JobSection>
            )}

            {/* ---- WAITING / HELD (§3) — hold styling, never active-looking ---- */}
            {show('WAITING') && (
              <JobSection
                title="Waiting / Held"
                count={heldJobs.length}
                accent="bg-amber-500"
                emptyText="No jobs currently on hold."
              >
                <div className="space-y-2">
                  {heldJobs.map((a) => {
                    const label =
                      a.orderStatus === 'WAITING_PARTS' ? 'WAITING FOR PARTS'
                        : a.orderStatus === 'WAITING_CUSTOMER' ? 'WAITING FOR CUSTOMER'
                          : 'PAUSED';
                    const heldMs = a.openPause ? now - new Date(a.openPause.startedAt).getTime() : 0;
                    return (
                      <div key={a.assignmentId} className="card px-4 py-3 space-y-2 border-amber-200 bg-amber-50/40">
                        <div className="flex items-center justify-between gap-2">
                          <PlateHeading a={a} />
                          <span className="badge bg-amber-100 text-amber-800 text-[10px] font-bold shrink-0">{label}</span>
                        </div>
                        <p className="text-sm text-slate-700">{a.services.join(', ')}</p>
                        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                          {a.openPause && (
                            <p className="text-xs text-amber-900">
                              {PAUSE_REASONS.find((r) => r.value === a.openPause!.reasonCode)?.label ?? a.openPause.reasonCode}
                              {' · '}since {fmtTime(a.openPause.startedAt)} · {fmtMins(heldMs)} waiting
                            </p>
                          )}
                          {a.openPause?.notes && <p className="text-xs text-amber-700 italic mt-0.5">“{a.openPause.notes}”</p>}
                          {a.openPause && <PauseAckLine p={a.openPause} />}
                        </div>
                        {resumeMutation.isError && resumeMutation.variables === a.orderId && (
                          <p className="text-xs text-red-600">{resumeMutation.error instanceof Error ? resumeMutation.error.message : 'Failed to resume'}</p>
                        )}
                        <div className="flex items-center justify-between gap-3">
                          <button
                            onClick={() => resumeMutation.mutate(a.orderId)}
                            disabled={resumeMutation.isPending}
                            className="btn-success flex-1 py-3 text-base font-bold rounded-lg active:scale-[0.98] transition-transform"
                          >
                            {resumeMutation.isPending && resumeMutation.variables === a.orderId
                              ? 'Resuming…'
                              : a.orderStatus === 'WAITING_PARTS' ? 'PARTS ARRIVED — RESUME' : 'RESUME WORK'}
                          </button>
                          <OpenJobLink orderId={a.orderId} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </JobSection>
            )}

            {/* ---- REWORK (§3) — high attention: why it came back ---- */}
            {show('REWORK') && (
              <JobSection
                title="Rework"
                count={reworkJobs.length}
                accent="bg-red-500"
                emptyText="No rework assigned."
              >
                <div className="space-y-2">
                  {reworkJobs.map((a) => (
                    <div key={a.assignmentId} className="card px-4 py-3 space-y-2 border-red-200 bg-red-50/40">
                      <div className="flex items-center justify-between gap-2">
                        <PlateHeading a={a} />
                        <span className="badge bg-red-100 text-red-700 text-[10px] font-bold shrink-0">REWORK</span>
                      </div>
                      <p className="text-sm text-slate-700">{a.services.join(', ')}</p>
                      {a.openRework && (
                        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                          <p className="text-xs font-semibold text-red-900">QC feedback: {a.openRework.reasonCode}</p>
                          {a.openRework.description && <p className="text-xs text-red-800 mt-0.5">{a.openRework.description}</p>}
                        </div>
                      )}
                      <JobChips a={a} />
                      {switchPanel(a)}
                      {(!switchFor || switchFor.orderId !== a.orderId) && (
                        <div className="flex items-center justify-between gap-3">
                          <button
                            onClick={() => startMutation.mutate({ orderId: a.orderId, assignmentId: a.assignmentId })}
                            disabled={startMutation.isPending}
                            className="btn-danger flex-1 py-3 text-base font-bold rounded-lg active:scale-[0.98] transition-transform"
                          >
                            ADDRESS REWORK
                          </button>
                          <OpenJobLink orderId={a.orderId} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </JobSection>
            )}

            {/* ---- AWAITING QC (§3) — distinct, not urgent ---- */}
            {show('QC') && (
              <JobSection
                title="Awaiting QC"
                count={awaitingQc.length}
                accent="bg-violet-500"
                emptyText="Nothing awaiting QC."
              >
                <div className="card divide-y divide-slate-100">
                  {awaitingQc.map((a) => (
                    <div key={a.assignmentId} className="px-4 py-2.5 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-sm font-bold font-mono text-slate-800">{a.plate}</span>
                        <span className="text-xs text-slate-500 ml-2">{a.services.join(', ')}</span>
                        <p className="text-[11px] text-slate-400">Your work: {fmtMins(a.myWorkMs)}</p>
                      </div>
                      <span className="badge bg-violet-50 text-violet-700 text-[10px] shrink-0">AWAITING QC</span>
                    </div>
                  ))}
                </div>
              </JobSection>
            )}

            {/* ---- COMPLETED TODAY (§3) — collapsed, muted, reference only ---- */}
            {show('DONE') && finishedToday.length > 0 && (
              <details className="group" open={filter === 'DONE'}>
                <summary className="flex items-center gap-2 mb-2 cursor-pointer list-none">
                  <span className="w-2 h-2 rounded-full bg-slate-300" />
                  <h3 className="text-sm font-bold text-slate-600">Completed Today</h3>
                  <span className="text-xs text-slate-400">({finishedToday.length})</span>
                  <span className="text-xs text-slate-400 group-open:hidden">— show</span>
                  <span className="text-xs text-slate-400 hidden group-open:inline">— hide</span>
                </summary>
                <div className="card divide-y divide-slate-100">
                  {finishedToday.map((a) => (
                    <div key={a.assignmentId} className="px-4 py-2.5 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-sm font-bold font-mono text-slate-500">{a.plate}</span>
                        <span className="text-xs text-slate-400 ml-2">{a.services.join(', ')}</span>
                        <p className="text-[11px] text-slate-400">Your work: {fmtMins(a.myWorkMs)}</p>
                      </div>
                      <span className="badge bg-emerald-50 text-emerald-600 text-[10px] shrink-0">DONE</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {assignments.length === 0 && !myAssignmentsQuery.isError && (
              <EmptyState
                title="Nothing assigned to you"
                description="When the front desk assigns you a job it will appear here."
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
