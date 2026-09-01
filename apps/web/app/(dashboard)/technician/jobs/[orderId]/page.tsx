'use client';

/**
 * CR-2026-101 — the Technician Job Workspace.
 *
 * Purpose-built, not a restricted manager screen: everything the technician
 * needs to KNOW (customer read-only, vehicle record, concern, authorized work,
 * history, previous inspections) and everything they may DO (start / pause /
 * resume / send to QC, record findings, flag safety, report incorrect data) —
 * with master-data editing deliberately absent, here and at the API.
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../../../../lib/api-client';
import { LoadingState } from '../../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../../components/status-badge';
import { PAUSE_REASONS } from '../../../../../lib/service-order-actions';
import { KpiStrip, type LiveKpi } from '../../../../../components/kpi-strip';
import { ServiceQualifiers } from '../../../../../components/service-qualifiers';
import { VisitNotesCard } from '../../../../../components/visit-notes-card';

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtMins(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

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
const DECISION_CHIP: Record<string, { label: string; className: string }> = {
  PENDING: { label: 'Authorization pending', className: 'bg-amber-50 text-amber-800' },
  APPROVED: { label: 'Approved', className: 'bg-emerald-50 text-emerald-700' },
  DECLINED: { label: 'Declined', className: 'bg-slate-100 text-slate-500' },
  DEFERRED: { label: 'Deferred', className: 'bg-slate-100 text-slate-500' },
};

interface JobContext {
  order: {
    id: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    promisedCompletionAt: string | null;
    advisorNotes: string | null;
    services: Array<{ code: string; name: string; durationMinutes: number | null }>;
    expectedMinutes: number;
    assignments: Array<{ technicianName: string; isPrimary: boolean; startedAt: string | null; bay: string | null; bayType: string | null }>;
    openPause: { reasonCode: string; notes: string | null; startedAt: string; approvalStatus: string; enteredOnBehalf: boolean } | null;
    openRework: { reasonCode: string; description: string | null; openedAt: string } | null;
    reworkCount: number;
  };
  timing: {
    startedAt: string | null;
    pausedMs: number;
    waitingPartsMs: number;
    waitingCustomerMs: number;
    otherPausedMs: number;
    openPauseStartedAt: string | null;
  };
  visit: {
    id: string;
    visitNumber: string | null;
    sourceType: string;
    status: string;
    checkedInAt: string | null;
    mileageIn: number | null;
    intakeNotes: string | null;
    oilRequested: string | null;
    priorityClass: string | null;
    partsReadiness: string;
    appointmentAt: string | null;
    appointmentNotes: string | null;
    queueTicketId: string | null;
    ticketNumber: string | null;
    jobSheet: { savedAt: string | null; jobSheetNumber: string | null };
  };
  customer: {
    firstName: string;
    lastName: string;
    customerNumber: string;
    phone: string;
    email: string | null;
    loyaltyMember: boolean;
    notificationOptInSms: boolean;
    notificationOptInEmail: boolean;
    notes: string | null;
  };
  vehicle: {
    id: string;
    plateNumber: string;
    vin: string | null;
    make: string | null;
    model: string | null;
    modelYear: number | null;
    color: string | null;
    odometer: number | null;
    serviceClass: string | null;
    fuelType: string | null;
    transmission: string | null;
    drivetrain: string | null;
    engineNo: string | null;
  };
  inspections: Array<{
    id: string;
    inspectionNumber: string;
    status: string;
    createdAt: string;
    recommendations: Array<{ id: string; severity: string; description: string; customerDecision: string; resultingServiceOrderId: string | null }>;
  }>;
}

interface HistoryRow {
  serviceVisitId: string;
  visitNumber: string | null;
  sourceType: string;
  date: string;
  mileageIn: number | null;
  notes: string | null;
  services: string[];
  hadRework: boolean;
  hadPartsWait: boolean;
  inspections: Array<{
    id: string;
    inspectionNumber: string;
    status: string;
    date: string;
    comments: string | null;
    recommendations: Array<{ severity: string; description: string; customerDecision: string }>;
  }>;
}

interface MyAssignment {
  assignmentId: string;
  orderId: string;
  orderStatus: string;
  hasOpenSegment: boolean;
}

function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button onClick={() => setOpen(!open)} className="w-full card-header flex items-center justify-between text-left">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <span className="text-slate-400 text-sm">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="card-body">{children}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="input-label">{label}</div>
      <p className="text-sm font-medium text-slate-900">{value ?? '—'}</p>
    </div>
  );
}

export default function TechnicianJobWorkspace() {
  const { orderId } = useParams<{ orderId: string }>();
  const queryClient = useQueryClient();

  const ctxQuery = useQuery<JobContext>({
    queryKey: ['job-context', orderId],
    queryFn: () => api.get(`/service-orders/${orderId}/context`),
    refetchInterval: 15000,
  });
  const historyQuery = useQuery<HistoryRow[]>({
    queryKey: ['vehicle-history', orderId],
    queryFn: () => api.get(`/service-orders/${orderId}/vehicle-history`),
  });
  // My assignment on this order (for the start action + on-the-clock marker).
  const mineQuery = useQuery<MyAssignment[]>({
    queryKey: ['my-assignments'],
    queryFn: () => api.get('/service-orders/mine/assignments'),
    refetchInterval: 15000,
  });
  const kpiQuery = useQuery<LiveKpi>({
    queryKey: ['kpi-live', orderId],
    queryFn: () => api.get(`/kpi/orders/${orderId}/live`),
    refetchInterval: 30000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['job-context', orderId] });
    queryClient.invalidateQueries({ queryKey: ['my-assignments'] });
    queryClient.invalidateQueries({ queryKey: ['kpi-live', orderId] });
  };

  const [pauseReason, setPauseReason] = useState<string>(PAUSE_REASONS[0].value);
  const [pauseNotes, setPauseNotes] = useState('');
  const [showPause, setShowPause] = useState(false);
  const [switchPrompt, setSwitchPrompt] = useState<string | null>(null);
  const [switchReason, setSwitchReason] = useState<string>(PAUSE_REASONS[0].value);
  const [switchNotes, setSwitchNotes] = useState('');

  const myRow = (mineQuery.data ?? []).find((a) => a.orderId === orderId);

  const startMutation = useMutation({
    mutationFn: (hold?: { reasonCode: string; notes?: string }) =>
      api.post(
        `/service-orders/${orderId}/assignments/${myRow!.assignmentId}/start`,
        hold ? { holdReasonCode: hold.reasonCode, ...(hold.notes ? { holdNotes: hold.notes } : {}) } : {},
      ),
    onSuccess: () => { invalidate(); setSwitchPrompt(null); },
    onError: (err) => {
      if (err instanceof ApiError && (err.body as { code?: string })?.code === 'ACTIVE_WORK_ELSEWHERE') {
        const active = ((err.body as { activeJobs?: Array<{ ticketNumber: string | null; plate: string }> }).activeJobs ?? [])[0];
        setSwitchPrompt(active?.ticketNumber ?? active?.plate ?? 'your current job');
      }
    },
  });
  const pauseMutation = useMutation({
    mutationFn: () =>
      api.post(`/service-orders/${orderId}/pause`, {
        reasonCode: pauseReason,
        ...(pauseNotes.trim() ? { notes: pauseNotes.trim() } : {}),
      }),
    onSuccess: () => { invalidate(); setShowPause(false); setPauseNotes(''); },
  });
  const resumeMutation = useMutation({
    mutationFn: () => api.post(`/service-orders/${orderId}/resume`, {}),
    onSuccess: invalidate,
  });
  const qcMutation = useMutation({
    mutationFn: () => api.post(`/service-orders/${orderId}/ready-for-qc`, {}),
    onSuccess: invalidate,
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (ctxQuery.isLoading) {
    return (
      <div className="min-h-screen bg-slate-100 p-4">
        <div className="max-w-2xl mx-auto"><LoadingState message="Loading job..." /></div>
      </div>
    );
  }
  if (ctxQuery.isError || !ctxQuery.data) {
    return (
      <div className="min-h-screen bg-slate-100 p-4">
        <div className="max-w-2xl mx-auto space-y-3">
          <Link href="/technician" className="text-sm text-blue-700 hover:underline">← My Jobs</Link>
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Could not load this job.{ctxQuery.error instanceof Error ? ` ${ctxQuery.error.message}` : ''}
          </div>
        </div>
      </div>
    );
  }

  const ctx = ctxQuery.data;
  const { order, visit, customer, vehicle, timing } = ctx;
  // §12 — the customer's stated concern, prominent, never buried.
  const concern = visit.appointmentNotes ?? visit.intakeNotes ?? null;
  const startedMs = timing.startedAt ? new Date(timing.startedAt).getTime() : null;
  const openPauseMs = timing.openPauseStartedAt ? now - new Date(timing.openPauseStartedAt).getTime() : 0;
  const elapsedMs = startedMs ? now - startedMs : 0;
  const workingMs = startedMs ? elapsedMs - timing.pausedMs - openPauseMs : 0;
  const expectedMs = order.expectedMinutes * 60000;
  const overExpected = startedMs && expectedMs > 0 && elapsedMs > expectedMs;
  const isHeld = ['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER'].includes(order.status);
  // Recommendations across current inspections (§15 — visible, never decidable here).
  const recommendations = ctx.inspections.flatMap((i) =>
    i.recommendations.map((r) => ({ ...r, inspectionNumber: i.inspectionNumber })),
  );

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="max-w-2xl mx-auto space-y-3">
        <Link href="/technician" className="text-sm text-blue-700 hover:underline">← My Jobs</Link>

        {/* ---- Header: what vehicle is this? ---- */}
        <div className="card overflow-hidden">
          <div className="bg-blue-600 text-white px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                {/* CR-2026-102 §1/§10 — the vehicle itself opens the technician-safe
                    vehicle view (full record + history). */}
                <Link href={`/technician/vehicles/${vehicle.id}`} className="text-3xl font-black font-mono tracking-wide hover:underline">
                  {vehicle.plateNumber}
                </Link>
                <div className="text-sm text-blue-100 mt-0.5">
                  {[vehicle.modelYear, vehicle.make, vehicle.model].filter(Boolean).join(' ')}
                  {vehicle.serviceClass ? ` · ${VEHICLE_CLASS_LABEL[vehicle.serviceClass] ?? ''}` : ''}
                </div>
                <div className="text-xs text-blue-200 mt-1">
                  {customer.firstName} {customer.lastName}
                  {visit.ticketNumber ? ` · ${visit.ticketNumber}` : ''}
                  {visit.visitNumber ? ` · Visit ${visit.visitNumber}` : ''}
                </div>
              </div>
              <div className="text-right space-y-1 shrink-0">
                <StatusBadge status={order.status} />
                {order.assignments[0]?.bay && (
                  <div className="text-xs text-blue-100">Bay {order.assignments[0].bay}</div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/15">
                {visit.sourceType === 'APPOINTMENT'
                  ? `Appointment${visit.appointmentAt ? ` · ${fmtTime(visit.appointmentAt)}` : ''}`
                  : 'Walk-in'}
              </span>
              {visit.priorityClass && PRIORITY_LABEL[visit.priorityClass] && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/15">{PRIORITY_LABEL[visit.priorityClass]}</span>
              )}
              {order.expectedMinutes > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/15">Expected {fmtMins(expectedMs)}</span>
              )}
              {visit.mileageIn != null && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/15">{visit.mileageIn.toLocaleString()} mi in</span>
              )}
              {order.openRework && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/80 font-semibold">REWORK</span>
              )}
            </div>
          </div>

          <div className="card-body space-y-3">
            {/* §12 — customer concern, front and centre */}
            {concern && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                <div className="text-[11px] font-bold uppercase tracking-wide text-blue-800">Customer concern</div>
                <p className="text-sm text-blue-900 mt-0.5">{concern}</p>
              </div>
            )}
            {order.advisorNotes && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Advisor note</div>
                <p className="text-sm text-slate-800 mt-0.5">{order.advisorNotes}</p>
              </div>
            )}
            {order.openRework && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                <div className="text-[11px] font-bold uppercase tracking-wide text-red-800">Returned for rework</div>
                <p className="text-sm text-red-900 mt-0.5">
                  {order.openRework.reasonCode}
                  {order.openRework.description ? ` — ${order.openRework.description}` : ''}
                </p>
              </div>
            )}

            {/* Services */}
            <div>
              <div className="input-label">Work on this job</div>
              <ul className="mt-1 space-y-1">
                {order.services.map((s) => (
                  <li key={s.code} className="flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-900">{s.name}</span>
                    {s.durationMinutes != null && <span className="text-xs text-slate-400">{s.durationMinutes}m</span>}
                  </li>
                ))}
              </ul>
              <ServiceQualifiers orderId={order.id} invalidateKeys={[['kpi-live', order.id]]} />
            </div>

            {/* Timers (§11) */}
            {startedMs ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className={`rounded-xl border p-3 text-center ${overExpected ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}>
                    <div className="input-label">Elapsed{overExpected ? ' · over expected' : ''}</div>
                    <div className={`text-2xl font-bold font-mono tabular-nums mt-0.5 ${overExpected ? 'text-amber-700' : 'text-slate-900'}`}>{fmtClock(elapsedMs)}</div>
                  </div>
                  <div className={`rounded-xl border p-3 text-center ${isHeld ? 'bg-orange-50 border-orange-200' : 'bg-emerald-50 border-emerald-200'}`}>
                    <div className="input-label">Working{isHeld ? ' (stopped)' : ''}</div>
                    <div className={`text-2xl font-bold font-mono tabular-nums mt-0.5 ${isHeld ? 'text-orange-700' : 'text-emerald-700'}`}>{fmtClock(workingMs)}</div>
                  </div>
                </div>
                <KpiStrip kpi={kpiQuery.data} />
              </>
            ) : null}

            {/* Hold state */}
            {order.openPause && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
                <span className="font-semibold">
                  {PAUSE_REASONS.find((r) => r.value === order.openPause!.reasonCode)?.label ?? order.openPause.reasonCode}
                </span>
                <p className="text-xs mt-0.5">
                  Since {fmtTime(order.openPause.startedAt)}
                  {order.openPause.approvalStatus === 'PENDING' ? ' — awaiting advisor/manager acknowledgement' : ''}
                </p>
                {order.openPause.notes && <p className="text-xs italic mt-0.5">“{order.openPause.notes}”</p>}
              </div>
            )}

            {/* ---- Actions ---- */}
            {myRow && order.status === 'ASSIGNED' && (
              <>
                {switchPrompt ? (
                  <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                    <p className="text-sm font-semibold text-amber-900">You’re on the clock for {switchPrompt}.</p>
                    <select value={switchReason} onChange={(e) => setSwitchReason(e.target.value)} className="input-field">
                      {PAUSE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <textarea value={switchNotes} onChange={(e) => setSwitchNotes(e.target.value)} rows={2} className="input-field text-sm" placeholder="Note (optional)" />
                    <div className="flex gap-2">
                      <button
                        onClick={() => startMutation.mutate({ reasonCode: switchReason, notes: switchNotes.trim() || undefined })}
                        disabled={startMutation.isPending}
                        className="btn-primary flex-1 py-3 font-semibold rounded-lg"
                      >
                        HOLD IT & SWITCH
                      </button>
                      <button onClick={() => setSwitchPrompt(null)} className="btn-secondary py-3 px-4 rounded-lg">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => startMutation.mutate(undefined)}
                    disabled={startMutation.isPending}
                    className="btn-success w-full py-4 text-lg font-bold rounded-lg active:scale-[0.98] transition-transform"
                  >
                    {startMutation.isPending ? 'Starting…' : 'START WORK'}
                  </button>
                )}
                {startMutation.isError && !switchPrompt && (
                  <p className="text-xs text-red-600 text-center">{startMutation.error instanceof Error ? startMutation.error.message : 'Failed to start'}</p>
                )}
              </>
            )}
            {isHeld && (
              <>
                {resumeMutation.isError && (
                  <p className="text-xs text-red-600 text-center">{resumeMutation.error instanceof Error ? resumeMutation.error.message : 'Failed to resume'}</p>
                )}
                <button onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending} className="btn-success w-full py-4 text-lg font-bold rounded-lg">
                  {resumeMutation.isPending ? 'Resuming…' : order.status === 'WAITING_PARTS' ? 'PARTS ARRIVED — RESUME' : 'RESUME WORK'}
                </button>
              </>
            )}
            {order.status === 'IN_PROGRESS' && (
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
                    <p className="text-[11px] text-orange-800">The clock stops the moment you confirm. An advisor/manager will acknowledge it.</p>
                    {pauseMutation.isError && (
                      <p className="text-xs text-red-700">{pauseMutation.error instanceof Error ? pauseMutation.error.message : 'Failed to pause'}</p>
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending} className="btn-primary flex-1 py-3 font-semibold rounded-lg">
                        {pauseMutation.isPending ? 'Stopping…' : pauseReason === 'WAITING_PARTS' ? 'Mark Waiting for Parts' : 'Confirm Pause'}
                      </button>
                      <button onClick={() => { setShowPause(false); setPauseNotes(''); }} className="btn-secondary py-3 px-4 rounded-lg">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setShowPause(true)} className="btn-secondary w-full py-3 text-base font-semibold rounded-lg">
                    Pause / Report a Hold-up
                  </button>
                )}
                {qcMutation.isError && (
                  <p className="text-xs text-red-600 text-center">{qcMutation.error instanceof Error ? qcMutation.error.message : 'Failed'}</p>
                )}
                <button onClick={() => qcMutation.mutate()} disabled={qcMutation.isPending} className="btn-success w-full py-4 text-lg font-bold rounded-lg">
                  {qcMutation.isPending ? 'Sending…' : 'FINISHED AND READY FOR REVIEW'}
                </button>
              </div>
            )}

            {/* §5 — the job sheet, one tap, always */}
            <div className="grid grid-cols-2 gap-2">
              <Link
                href={`/inspections/job-sheet/${visit.id}`}
                className="block text-center rounded-lg border border-blue-200 bg-blue-50 py-3 text-sm font-bold text-blue-800"
              >
                VIEW JOB SHEET
                {visit.jobSheet.jobSheetNumber && (
                  <span className="block text-[10px] font-mono font-normal text-blue-600">{visit.jobSheet.jobSheetNumber}</span>
                )}
              </Link>
              {ctx.inspections[0] ? (
                <Link
                  href={`/inspections/${ctx.inspections[0].id}`}
                  className="block text-center rounded-lg border border-slate-200 py-3 text-sm font-bold text-slate-700"
                >
                  INSPECTION
                  <span className="block text-[10px] font-mono font-normal text-slate-500">
                    {ctx.inspections[0].inspectionNumber} · {ctx.inspections[0].status}
                  </span>
                </Link>
              ) : (
                <div className="rounded-lg border border-slate-100 py-3 text-center text-xs text-slate-400">
                  No inspection on this visit yet
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ---- §15 — recommended additional work + authorization state ---- */}
        {recommendations.length > 0 && (
          <div className="card">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Additional Work & Authorization</h2></div>
            <div className="card-body space-y-1.5">
              <p className="text-[11px] text-slate-400">
                The advisor handles customer authorization — approved items become work you can see here.
              </p>
              {recommendations.map((r) => {
                const chip = DECISION_CHIP[r.customerDecision] ?? DECISION_CHIP.PENDING;
                return (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-800">{r.description}</p>
                      <p className="text-[11px] text-slate-400">{r.inspectionNumber}</p>
                    </div>
                    <span className={`badge text-[10px] shrink-0 ${chip.className}`}>{chip.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ---- §1 — customer, read-only ---- */}
        <Section title="Customer (read-only)">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Field label="Name" value={`${customer.firstName} ${customer.lastName}`} />
            <Field label="Account #" value={customer.customerNumber} />
            <Field label="Phone" value={customer.phone} />
            <Field label="Email" value={customer.email ?? '—'} />
            <Field
              label="Preferred contact"
              value={
                customer.notificationOptInSms && customer.notificationOptInEmail
                  ? 'SMS or email'
                  : customer.notificationOptInSms
                    ? 'SMS'
                    : customer.notificationOptInEmail
                      ? 'Email'
                      : 'No messaging — advisor calls'
              }
            />
            <Field label="Loyalty" value={customer.loyaltyMember ? 'Member' : '—'} />
          </div>
          {customer.notes && (
            <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Service notes</div>
              <p className="text-sm text-slate-800 mt-0.5">{customer.notes}</p>
            </div>
          )}
          <p className="text-[11px] text-slate-400 mt-3">
            Customer contact and record changes are handled by the advisor. Spotted something wrong? Use
            “Add Note → Incorrect information” below — it goes straight to them.
          </p>
        </Section>

        {/* ---- §3 — vehicle, read-only ---- */}
        <Section title="Vehicle (read-only)">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Field label="Registration" value={<span className="font-mono">{vehicle.plateNumber}</span>} />
            <Field label="Make / Model" value={[vehicle.modelYear, vehicle.make, vehicle.model].filter(Boolean).join(' ') || '—'} />
            <Field label="Vehicle type" value={vehicle.serviceClass ? (VEHICLE_CLASS_LABEL[vehicle.serviceClass] ?? '—') : 'Not set'} />
            <Field label="VIN / Chassis" value={vehicle.vin ? <span className="font-mono text-xs">{vehicle.vin}</span> : '—'} />
            <Field label="Engine no." value={vehicle.engineNo ?? '—'} />
            <Field label="Mileage in" value={visit.mileageIn != null ? `${visit.mileageIn.toLocaleString()} mi` : '—'} />
            <Field label="Fuel" value={vehicle.fuelType ?? '—'} />
            <Field label="Transmission" value={vehicle.transmission ?? '—'} />
            <Field label="Drivetrain" value={vehicle.drivetrain ?? '—'} />
            <Field label="Colour" value={vehicle.color ?? '—'} />
            {visit.oilRequested && <Field label="Oil requested" value={visit.oilRequested} />}
          </div>
        </Section>

        {/* ---- §6/§7 — service history + previous inspections ---- */}
        <Section title={`Vehicle Service History${historyQuery.data ? ` (${historyQuery.data.length})` : ''}`}>
          {historyQuery.isLoading && <p className="text-xs text-slate-500">Loading history…</p>}
          {historyQuery.isError && (
            <p className="text-xs text-red-600">Could not load history.{historyQuery.error instanceof Error ? ` ${historyQuery.error.message}` : ''}</p>
          )}
          {historyQuery.isSuccess && historyQuery.data.length === 0 && (
            <p className="text-xs text-slate-400">First recorded visit for this vehicle.</p>
          )}
          <div className="space-y-2">
            {(historyQuery.data ?? []).map((h) => (
              <div key={h.serviceVisitId} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">{fmtDate(h.date)}</span>
                  <span className="text-[11px] text-slate-400">
                    {h.mileageIn != null ? `${h.mileageIn.toLocaleString()} mi` : ''}
                    {h.visitNumber ? ` · ${h.visitNumber}` : ''}
                  </span>
                </div>
                <p className="text-sm text-slate-700 mt-0.5">{h.services.join(', ') || 'No services recorded'}</p>
                {h.notes && <p className="text-xs text-slate-500 italic mt-0.5">“{h.notes}”</p>}
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {h.hadRework && <span className="badge bg-red-50 text-red-700 text-[10px]">Came back for rework</span>}
                  {h.hadPartsWait && <span className="badge bg-amber-50 text-amber-700 text-[10px]">Waited for parts</span>}
                </div>
                {h.inspections.map((insp) => (
                  <div key={insp.id} className="mt-2 rounded border border-slate-100 bg-slate-50 px-2.5 py-1.5">
                    {/* §7 — dates ALWAYS visible: an old inspection must never read as current. */}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono font-semibold text-slate-600">{insp.inspectionNumber}</span>
                      <span className="text-[11px] text-slate-400">{fmtDate(insp.date)} · {insp.status}</span>
                    </div>
                    {insp.comments && <p className="text-xs text-slate-600 mt-0.5">{insp.comments}</p>}
                    {insp.recommendations.map((r, i) => (
                      <p key={i} className="text-xs text-slate-600 mt-0.5">
                        • {r.description}{' '}
                        <span className={`${r.customerDecision === 'PENDING' ? 'text-amber-700' : r.customerDecision === 'APPROVED' ? 'text-emerald-700' : 'text-slate-400'}`}>
                          ({(DECISION_CHIP[r.customerDecision] ?? DECISION_CHIP.PENDING).label.toLowerCase()})
                        </span>
                      </p>
                    ))}
                  </div>
                ))}
                <Link href={`/visits/${h.serviceVisitId}`} className="inline-block text-[11px] text-blue-700 hover:underline mt-1.5">
                  Full visit record →
                </Link>
              </div>
            ))}
          </div>
        </Section>

        {/* ---- §13/§14 — typed notes: findings, safety flags, data reports ---- */}
        <VisitNotesCard
          visitId={visit.id}
          serviceOrderId={order.id}
          addableKinds={['TECHNICIAN', 'SAFETY', 'DATA_REPORT']}
          title="Notes & Findings"
        />
      </div>
    </div>
  );
}
