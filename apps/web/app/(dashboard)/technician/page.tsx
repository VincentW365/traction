'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../../lib/api-client';
import { PageHeader } from '../../../components/ui/page-header';
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
 *
 * A technician legitimately holds SEVERAL jobs at once: one being worked, one
 * waiting on parts, one on customer authorisation, a small job not yet started.
 * Every job renders as its own card with its own actions; the one with an open
 * labour segment is "on the clock" — and only one can be, the API enforces it.
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
  sourceType: string | null;
  appointmentAt: string | null;
  hasOpenRework: boolean;
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

const fmtApptTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** Compact identity block every job card shares (CR-2026-100 §1, CR-2026-101). */
function JobIdentity({ a }: { a: MyAssignment }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/technician/jobs/${a.orderId}`} className="text-lg font-bold font-mono text-blue-700 hover:underline">
          {a.ticketNumber ?? a.plate}
        </Link>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {a.hasOpenRework && <span className="badge bg-red-100 text-red-700 text-[10px] font-bold">REWORK</span>}
          {a.appointmentAt && (
            <span className="badge bg-blue-50 text-blue-700 text-[10px]">Appt {fmtApptTime(a.appointmentAt)}</span>
          )}
          {a.expectedMinutes > 0 && (
            <span className="badge bg-slate-100 text-slate-600 text-[10px]">~{fmtMins(a.expectedMinutes * 60000)}</span>
          )}
          {a.vehicleClass && (
            <span className="badge bg-slate-100 text-slate-600 text-[10px]">{VEHICLE_CLASS_LABEL[a.vehicleClass] ?? a.vehicleClass}</span>
          )}
          {a.priorityClass && PRIORITY_LABEL[a.priorityClass] && (
            <span className="badge bg-indigo-50 text-indigo-700 text-[10px]">{PRIORITY_LABEL[a.priorityClass]}</span>
          )}
          {a.bay && <span className="badge bg-slate-100 text-slate-600 text-[10px]">Bay {a.bay}</span>}
        </div>
      </div>
      <p className="text-sm text-slate-700">{a.customerName} · {a.vehicle} ({a.plate})</p>
      <p className="text-xs text-slate-500">{a.services.join(', ')}</p>
      {/* §12 — the customer's stated concern rides the card, never buried. */}
      {a.concern && <p className="text-xs text-blue-800 bg-blue-50 rounded px-2 py-1">“{a.concern}”</p>}
      {a.visitNumber && <p className="text-[11px] font-mono text-slate-400">Visit {a.visitNumber}</p>}
    </div>
  );
}

/** CR-2026-101 §5 — one tap into the purpose-built job workspace. */
function OpenJobLink({ orderId }: { orderId: string }) {
  return (
    <Link
      href={`/technician/jobs/${orderId}`}
      className="block text-center rounded-lg border border-blue-200 bg-blue-50 py-2 text-sm font-semibold text-blue-800 hover:border-blue-300 transition-colors"
    >
      Open Job — customer, vehicle, history
    </Link>
  );
}

/** CR-2026-100 §4 — the job sheet is one tap from every job card. */
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

export default function TechnicianWorkView() {
  const queryClient = useQueryClient();

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
    queryClient.invalidateQueries({ queryKey: ['tech-inspections'] });
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

  const inspectionsQuery = useQuery<{ items: Array<{ id: string; inspectionNumber: string; status: string }> }>({
    queryKey: ['tech-inspections', currentJob?.serviceVisitId],
    queryFn: () => api.get(`/inspections?serviceVisitId=${currentJob!.serviceVisitId}`),
    enabled: !!currentJob,
  });

  // Timer math for the on-the-clock job: elapsed since start, and ACTUAL working time.
  const timing = workTimingQuery.data;
  const startedMs = timing?.startedAt ? new Date(timing.startedAt).getTime() : null;
  const openPauseMs = timing?.openPauseStartedAt ? now - new Date(timing.openPauseStartedAt).getTime() : 0;
  const elapsedMs = startedMs ? now - startedMs : 0;
  const workingMs = startedMs ? elapsedMs - (timing?.pausedMs ?? 0) - openPauseMs : 0;

  if (myAssignmentsQuery.isLoading) {
    return (
      <div className="min-h-screen bg-slate-100 p-4">
        <div className="max-w-md mx-auto">
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
      <div className="max-w-md mx-auto space-y-4">
        <PageHeader title="My Jobs" subtitle="Technician View" />

        {/* CR-2026-101 §10 — the workday at a glance: now / blocked / next. */}
        <div className="card">
          <div className="card-body py-3">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
              <div>
                <div className="text-lg font-bold tabular-nums text-emerald-700">{currentJob ? 1 : 0}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide">Active</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums text-slate-900">{readyToStart.length}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide">Up Next</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums text-amber-700">{heldJobs.length}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide">Waiting</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums text-red-700">{reworkJobs.length}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide">Rework</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums text-violet-700">{awaitingQc.length}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide">In QC</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums text-slate-500">{finishedToday.length}</div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide">Done</div>
              </div>
            </div>
            {workdayQuery.data && (
              <p className="text-center text-[11px] text-slate-500 mt-2">
                Your work today: <span className="font-semibold text-slate-700">{fmtMins(workdayQuery.data.todayWorkMs)}</span>
                {workdayQuery.data.activeSegmentStartedAt ? ' · clock running' : ''}
              </p>
            )}
          </div>
        </div>

        {myAssignmentsQuery.isError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Could not load your work.{' '}
            {myAssignmentsQuery.error instanceof Error ? myAssignmentsQuery.error.message : ''}
          </div>
        )}

        {/* ON THE CLOCK — the one job whose labour timer is running */}
        {currentJob && (
          <div className="card overflow-hidden">
            <div className="bg-blue-600 text-white px-5 py-4 text-center">
              <div className="text-[11px] uppercase tracking-wider text-blue-100">
                {currentJob.hasOpenSegment ? 'Working Now' : 'Current Job'}
              </div>
              <div className="text-3xl font-bold font-mono mt-0.5">{currentJob.ticketNumber ?? '—'}</div>
              <div className="text-xs text-blue-100 mt-1">
                {currentJob.customerName} · {currentJob.vehicle} ({currentJob.plate})
                {currentJob.vehicleClass ? ` · ${VEHICLE_CLASS_LABEL[currentJob.vehicleClass] ?? ''}` : ''}
                {currentJob.bay ? ` · Bay ${currentJob.bay}` : ''}
              </div>
              {currentJob.visitNumber && (
                <div className="text-[10px] font-mono text-blue-200 mt-0.5">Visit {currentJob.visitNumber}</div>
              )}
            </div>

            <div className="card-body space-y-4">
              {startedMs ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-center">
                      <div className="input-label">Elapsed</div>
                      <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-0.5">{fmtClock(elapsedMs)}</div>
                    </div>
                    <div className="rounded-xl border p-3 text-center bg-emerald-50 border-emerald-200">
                      <div className="input-label">Working</div>
                      <div className="text-2xl font-bold font-mono tabular-nums mt-0.5 text-emerald-700">{fmtClock(workingMs)}</div>
                    </div>
                  </div>
                  {timing?.startedAt && <p className="text-[11px] text-slate-400 text-center">Started at {fmtTime(timing.startedAt)}</p>}
                </>
              ) : (
                <div className="text-center">
                  <StatusBadge status={currentJob.orderStatus} />
                </div>
              )}

              {/* CR-2026-088 — where this job stands against its standard. */}
              <KpiStrip kpi={kpiQuery.data} />

              <div>
                <div className="input-label">Services</div>
                <p className="text-base font-medium text-slate-900 mt-0.5">
                  {currentJob.services.length > 0 ? currentJob.services.join(', ') : 'No services recorded'}
                </p>
                <ServiceQualifiers
                  orderId={currentJob.orderId}
                  invalidateKeys={[['kpi-live', currentJob.orderId]]}
                />
              </div>

              {(inspectionsQuery.data?.items ?? []).length > 0 && (
                <div>
                  <div className="input-label">Vehicle Inspection</div>
                  <div className="mt-1 space-y-1.5">
                    {inspectionsQuery.data!.items.map((insp) => (
                      <Link key={insp.id} href={`/inspections/${insp.id}`} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 hover:border-blue-300 transition-colors">
                        <span className="font-mono text-xs font-semibold text-blue-600">{insp.inspectionNumber}</span>
                        <StatusBadge status={insp.status} />
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* CR-2026-100 §4 — the job sheet is never more than one tap away. */}
              <JobSheetLink visitId={currentJob.serviceVisitId} />
              {/* CR-2026-101 §5 — full context: customer, vehicle, history, notes. */}
              <OpenJobLink orderId={currentJob.orderId} />

              {currentJob.orderStatus === 'IN_PROGRESS' && (
                <div className="space-y-2">
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
                      {/* CR-2026-100 §5 — honest expectation: the stop takes effect
                          NOW; the advisor acknowledges it after the fact. */}
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
                    <button onClick={() => setShowPause(true)} className="btn-secondary w-full py-3 text-base font-semibold rounded-lg">
                      Pause / Report a Hold-up
                    </button>
                  )}

                  {readyForQcMutation.isError && (
                    <p className="text-xs text-red-600 text-center">{readyForQcMutation.error instanceof Error ? readyForQcMutation.error.message : 'Failed to send to QC'}</p>
                  )}
                  <button
                    onClick={() => readyForQcMutation.mutate(currentJob.orderId)}
                    disabled={readyForQcMutation.isPending}
                    className="btn-success w-full py-4 text-lg font-bold rounded-lg active:scale-[0.98] transition-transform"
                  >
                    {readyForQcMutation.isPending ? 'Sending…' : 'FINISHED AND READY FOR REVIEW'}
                  </button>
                  <p className="text-[11px] text-slate-400 text-center">Marks your work finished and notifies the manager for a quality check.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ON HOLD — parts / customer / paused. Each with its own resume. */}
        {heldJobs.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">Waiting / On Hold ({heldJobs.length})</h2>
            </div>
            <div className="card-body p-0">
              {heldJobs.map((a) => {
                const label =
                  a.orderStatus === 'WAITING_PARTS' ? 'Waiting for Parts'
                    : a.orderStatus === 'WAITING_CUSTOMER' ? 'Waiting on the Customer'
                      : `Paused — ${PAUSE_REASONS.find((r) => r.value === a.openPause?.reasonCode)?.label ?? 'work stopped'}`;
                const heldMs = a.openPause ? now - new Date(a.openPause.startedAt).getTime() : 0;
                return (
                  <div key={a.assignmentId} className="px-5 py-4 border-b border-slate-100 last:border-0 space-y-2">
                    <JobIdentity a={a} />
                    <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
                      <span className="font-semibold">{label}</span>
                      {a.openPause && (
                        <p className="text-xs mt-0.5 text-amber-800">
                          Since {fmtTime(a.openPause.startedAt)} · {fmtMins(heldMs)} waiting
                        </p>
                      )}
                      {a.openPause?.notes && <p className="text-xs mt-0.5 text-amber-700 italic">“{a.openPause.notes}”</p>}
                      {a.openPause && <PauseAckLine p={a.openPause} />}
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Your work so far: {fmtMins(a.myWorkMs)}
                    </p>
                    {resumeMutation.isError && resumeMutation.variables === a.orderId && (
                      <p className="text-xs text-red-600">{resumeMutation.error instanceof Error ? resumeMutation.error.message : 'Failed to resume'}</p>
                    )}
                    <button
                      onClick={() => resumeMutation.mutate(a.orderId)}
                      disabled={resumeMutation.isPending}
                      className="btn-success w-full py-3 text-base font-bold rounded-lg active:scale-[0.98] transition-transform"
                    >
                      {resumeMutation.isPending && resumeMutation.variables === a.orderId
                        ? 'Resuming…'
                        : a.orderStatus === 'WAITING_PARTS' ? 'PARTS ARRIVED — RESUME' : 'RESUME WORK'}
                    </button>
                    <JobSheetLink visitId={a.serviceVisitId} />
                    <OpenJobLink orderId={a.orderId} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* REWORK — returned after QC; restart like any assigned job (§8) */}
        {reworkJobs.length > 0 && (
          <div className="card border-red-200">
            <div className="card-header bg-red-50">
              <h2 className="text-sm font-semibold text-red-900">Rework ({reworkJobs.length})</h2>
            </div>
            <div className="card-body p-0">
              {reworkJobs.map((a) => (
                <div key={a.assignmentId} className="px-5 py-4 border-b border-slate-100 last:border-0 space-y-2">
                  <JobIdentity a={a} />
                  {switchPanel(a)}
                  {(!switchFor || switchFor.orderId !== a.orderId) && (
                    <button
                      onClick={() => startMutation.mutate({ orderId: a.orderId, assignmentId: a.assignmentId })}
                      disabled={startMutation.isPending}
                      className="btn-success w-full py-3 text-base font-bold rounded-lg active:scale-[0.98] transition-transform"
                    >
                      START REWORK
                    </button>
                  )}
                  <JobSheetLink visitId={a.serviceVisitId} />
                  <OpenJobLink orderId={a.orderId} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* UP NEXT — assigned, not begun (§8/§9) */}
        {readyToStart.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">Up Next ({readyToStart.length})</h2>
            </div>
            <div className="card-body p-0">
              {readyToStart.map((a) => (
                <div key={a.assignmentId} className="px-5 py-4 border-b border-slate-100 last:border-0 space-y-2">
                  <JobIdentity a={a} />
                  <ServiceQualifiers orderId={a.orderId} showCalculation={false} />
                  {switchPanel(a)}
                  {startMutation.isError &&
                    startMutation.variables?.assignmentId === a.assignmentId &&
                    !(startMutation.error instanceof ApiError && (startMutation.error.body as { code?: string })?.code === 'ACTIVE_WORK_ELSEWHERE') && (
                      <p className="text-xs text-red-600">{startMutation.error instanceof Error ? startMutation.error.message : 'Failed to start'}</p>
                    )}
                  {(!switchFor || switchFor.orderId !== a.orderId) && (
                    <button
                      onClick={() => startMutation.mutate({ orderId: a.orderId, assignmentId: a.assignmentId })}
                      disabled={startMutation.isPending}
                      className="btn-success w-full py-3 text-base font-bold rounded-lg active:scale-[0.98] transition-transform"
                    >
                      {startMutation.isPending && startMutation.variables?.assignmentId === a.assignmentId ? 'Starting…' : 'START WORK'}
                    </button>
                  )}
                  <JobSheetLink visitId={a.serviceVisitId} />
                  <OpenJobLink orderId={a.orderId} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* IN PROGRESS, NOT ON MY CLOCK — e.g. after switching away on a shared job */}
        {otherInProgress.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">Also In Progress ({otherInProgress.length})</h2>
            </div>
            <div className="card-body p-0">
              {otherInProgress.map((a) => (
                <div key={a.assignmentId} className="px-5 py-4 border-b border-slate-100 last:border-0 space-y-2">
                  <JobIdentity a={a} />
                  <p className="text-[11px] text-slate-500">
                    Not on your clock · your work so far: {fmtMins(a.myWorkMs)}
                  </p>
                  {switchPanel(a)}
                  {(!switchFor || switchFor.orderId !== a.orderId) && (
                    <button
                      onClick={() => startMutation.mutate({ orderId: a.orderId, assignmentId: a.assignmentId })}
                      disabled={startMutation.isPending}
                      className="btn-secondary w-full py-2.5 text-sm font-semibold rounded-lg"
                    >
                      BACK TO THIS JOB
                    </button>
                  )}
                  <JobSheetLink visitId={a.serviceVisitId} />
                  <OpenJobLink orderId={a.orderId} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AWAITING QC — handed over, read-only (§8) */}
        {awaitingQc.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">Awaiting QC ({awaitingQc.length})</h2>
            </div>
            <div className="card-body p-0">
              {awaitingQc.map((a) => (
                <div key={a.assignmentId} className="px-5 py-3 border-b border-slate-100 last:border-0 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-sm font-bold font-mono text-slate-900">{a.ticketNumber ?? '—'}</span>
                    <span className="text-sm text-slate-500 ml-2">{a.services.join(', ')}</span>
                    <p className="text-[11px] text-slate-400">Your work: {fmtMins(a.myWorkMs)}</p>
                  </div>
                  <StatusBadge status="QC" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* COMPLETED TODAY — for reference (§8) */}
        {finishedToday.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">Completed Today ({finishedToday.length})</h2>
            </div>
            <div className="card-body p-0">
              {finishedToday.map((a) => (
                <div key={a.assignmentId} className="px-5 py-3 border-b border-slate-100 last:border-0 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-sm font-bold font-mono text-slate-900">{a.ticketNumber ?? '—'}</span>
                    <span className="text-sm text-slate-500 ml-2">{a.services.join(', ')}</span>
                    <p className="text-[11px] text-slate-400">Your work: {fmtMins(a.myWorkMs)}</p>
                  </div>
                  <StatusBadge status={a.orderStatus} />
                </div>
              ))}
            </div>
          </div>
        )}

        {assignments.length === 0 && !myAssignmentsQuery.isError && (
          <EmptyState
            icon={
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
            title="Nothing assigned to you"
            description="When the front desk assigns you a job it will appear here."
          />
        )}
      </div>
    </div>
  );
}
