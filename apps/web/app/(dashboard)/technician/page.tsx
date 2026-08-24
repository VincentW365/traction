'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
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
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * CR-2026-084 — one assignment belonging to the logged-in technician.
 *
 * This screen used to derive its "Current Job" from the site-wide queue board, which
 * meant it showed whichever car was first at the whole site — frequently somebody
 * else's — and the card vanished the moment work started, because the board never
 * recorded a job as in service. It is now driven entirely by the technician's own
 * assignments, which is the only source that is actually scoped to them.
 */
interface MyAssignment {
  assignmentId: string;
  orderId: string;
  orderStatus: string;
  assignmentStatus: string;
  startedAt: string | null;
  serviceVisitId: string;
  ticketNumber: string | null;
  customerName: string;
  vehicle: string;
  plate: string;
  bay: string | null;
  services: string[];
}

// Order states that mean "this job is live on my bench right now".
const ACTIVE_ORDER_STATUSES = ['IN_PROGRESS', 'PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER'];

export default function TechnicianWorkView() {
  const queryClient = useQueryClient();

  const myAssignmentsQuery = useQuery<MyAssignment[]>({
    queryKey: ['my-assignments'],
    queryFn: () => api.get('/service-orders/mine/assignments'),
    refetchInterval: 10000,
  });

  const assignments = myAssignmentsQuery.data ?? [];
  const readyToStart = assignments.filter((a) => a.orderStatus === 'ASSIGNED');
  const activeJobs = assignments.filter((a) => ACTIVE_ORDER_STATUSES.includes(a.orderStatus));
  const currentJob = activeJobs[0] ?? null;
  const isPaused = currentJob?.orderStatus === 'PAUSED';

  const [pauseReason, setPauseReason] = useState<string>(PAUSE_REASONS[0].value);
  const [showPause, setShowPause] = useState(false);

  const invalidateWork = () => {
    queryClient.invalidateQueries({ queryKey: ['my-assignments'] });
    queryClient.invalidateQueries({ queryKey: ['work-timing'] });
    queryClient.invalidateQueries({ queryKey: ['tech-inspections'] });
  };

  const startMutation = useMutation({
    mutationFn: ({ orderId, assignmentId }: { orderId: string; assignmentId: string }) =>
      api.post(`/service-orders/${orderId}/assignments/${assignmentId}/start`, {}),
    onSuccess: invalidateWork,
  });
  const pauseMutation = useMutation({
    mutationFn: () => api.post(`/service-orders/${currentJob!.orderId}/pause`, { reasonCode: pauseReason }),
    onSuccess: () => { invalidateWork(); setShowPause(false); },
  });
  const resumeMutation = useMutation({
    mutationFn: () => api.post(`/service-orders/${currentJob!.orderId}/resume`, {}),
    onSuccess: invalidateWork,
  });
  const readyForQcMutation = useMutation({
    mutationFn: () => api.post(`/service-orders/${currentJob!.orderId}/ready-for-qc`, {}),
    onSuccess: invalidateWork,
  });

  // CR-2026-073 — live work timers.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const workTimingQuery = useQuery<{
    startedAt: string | null; completedAt: string | null; status: string; pausedMs: number; openPauseStartedAt: string | null;
  }>({
    queryKey: ['work-timing', currentJob?.orderId],
    queryFn: () => api.get(`/service-orders/${currentJob!.orderId}/work-timing`),
    enabled: !!currentJob,
    refetchInterval: 15000,
  });

  // CR-2026-088 — live KPI for the job in hand. Polls with the timers so the
  // countdown to the standard stays honest while work is under way.
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

  // Timer math: elapsed since start, and ACTUAL working time (elapsed − paused).
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

  return (
    <div className="min-h-screen bg-slate-100 p-4">
      <div className="max-w-md mx-auto space-y-4">
        <PageHeader title="My Work" subtitle="Technician View" />

        {myAssignmentsQuery.isError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Could not load your work.{' '}
            {myAssignmentsQuery.error instanceof Error ? myAssignmentsQuery.error.message : ''}
          </div>
        )}

        {/* Current job — the one on the bench right now */}
        {currentJob && (
          <div className="card overflow-hidden">
            <div className="bg-blue-600 text-white px-5 py-4 text-center">
              <div className="text-[11px] uppercase tracking-wider text-blue-100">Current Job</div>
              <div className="text-3xl font-bold font-mono mt-0.5">{currentJob.ticketNumber ?? '—'}</div>
              <div className="text-xs text-blue-100 mt-1">
                {currentJob.customerName} · {currentJob.vehicle} ({currentJob.plate})
                {currentJob.bay ? ` · Bay ${currentJob.bay}` : ''}
              </div>
            </div>

            <div className="card-body space-y-4">
              {startedMs ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-center">
                      <div className="input-label">Elapsed</div>
                      <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-0.5">{fmtClock(elapsedMs)}</div>
                    </div>
                    <div className={`rounded-xl border p-3 text-center ${isPaused ? 'bg-orange-50 border-orange-200' : 'bg-emerald-50 border-emerald-200'}`}>
                      <div className="input-label">Working{isPaused ? ' (paused)' : ''}</div>
                      <div className={`text-2xl font-bold font-mono tabular-nums mt-0.5 ${isPaused ? 'text-orange-700' : 'text-emerald-700'}`}>{fmtClock(workingMs)}</div>
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

                {/* CR-2026-092 — the technician is the person who actually knows
                    which axle and which brake work, so this is the right screen to
                    ask on, and the right place to show what the answer is worth. */}
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

              {/* Held by the front desk — the technician cannot clear these themselves. */}
              {(currentJob.orderStatus === 'WAITING_PARTS' || currentJob.orderStatus === 'WAITING_CUSTOMER') && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900 text-center">
                  <span className="font-semibold">
                    {currentJob.orderStatus === 'WAITING_PARTS' ? 'Waiting on parts' : 'Waiting on the customer'}
                  </span>
                  <p className="text-xs mt-1 text-amber-800">The front desk will release this when it is ready.</p>
                </div>
              )}

              {isPaused && (
                <div className="space-y-2">
                  <div className="rounded-lg bg-orange-50 border border-orange-200 px-4 py-2.5 text-sm text-orange-800 text-center font-medium">
                    Work is paused
                  </div>
                  {resumeMutation.isError && (
                    <p className="text-xs text-red-600 text-center">{resumeMutation.error instanceof Error ? resumeMutation.error.message : 'Failed to resume'}</p>
                  )}
                  <button
                    onClick={() => resumeMutation.mutate()}
                    disabled={resumeMutation.isPending}
                    className="btn-success w-full py-4 text-lg font-bold rounded-lg active:scale-[0.98] transition-transform"
                  >
                    {resumeMutation.isPending ? 'Resuming…' : 'RESUME WORK'}
                  </button>
                </div>
              )}

              {currentJob.orderStatus === 'IN_PROGRESS' && (
                <div className="space-y-2">
                  {showPause ? (
                    <div className="space-y-2 rounded-lg border border-orange-200 bg-orange-50 p-3">
                      <label className="input-label">Pause reason</label>
                      <select value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} className="input-field">
                        {PAUSE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                      {pauseMutation.isError && (
                        <p className="text-xs text-red-700">{pauseMutation.error instanceof Error ? pauseMutation.error.message : 'Failed to pause'}</p>
                      )}
                      <div className="flex gap-2">
                        <button onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending} className="btn-primary flex-1 py-3 font-semibold rounded-lg">
                          {pauseMutation.isPending ? 'Pausing…' : 'Confirm Pause'}
                        </button>
                        <button onClick={() => setShowPause(false)} className="btn-secondary py-3 px-4 rounded-lg">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setShowPause(true)} className="btn-secondary w-full py-3 text-base font-semibold rounded-lg">
                      Pause Work
                    </button>
                  )}

                  {readyForQcMutation.isError && (
                    <p className="text-xs text-red-600 text-center">{readyForQcMutation.error instanceof Error ? readyForQcMutation.error.message : 'Failed to send to QC'}</p>
                  )}
                  <button
                    onClick={() => readyForQcMutation.mutate()}
                    disabled={readyForQcMutation.isPending}
                    className="btn-success w-full py-4 text-lg font-bold rounded-lg active:scale-[0.98] transition-transform"
                  >
                    {/* Says "review" to the technician while still routing to QC —
                        finishing your work reads better than invoking a process. */}
                    {readyForQcMutation.isPending ? 'Sending…' : 'FINISHED AND READY FOR REVIEW'}
                  </button>
                  <p className="text-[11px] text-slate-400 text-center">Marks your work finished and notifies the manager for a quality check.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Assigned to me, not started yet */}
        {readyToStart.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">Ready to Start ({readyToStart.length})</h2>
            </div>
            <div className="card-body p-0">
              {readyToStart.map((a) => (
                <div key={a.assignmentId} className="px-5 py-4 border-b border-slate-100 last:border-0 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold font-mono text-blue-700">{a.ticketNumber ?? '—'}</span>
                    {a.bay && <span className="badge bg-slate-100 text-slate-600 text-[10px]">Bay {a.bay}</span>}
                  </div>
                  <p className="text-sm text-slate-700">{a.customerName} · {a.vehicle} ({a.plate})</p>
                  <p className="text-xs text-slate-500">{a.services.join(', ')}</p>
                  {/* CR-2026-092 — the API refuses to start a job whose qualifiers
                      are outstanding, so the question has to be answerable here
                      rather than arriving as a refusal on START WORK. The breakdown
                      stays off this list; it belongs on the job in hand. */}
                  <ServiceQualifiers orderId={a.orderId} showCalculation={false} />
                  {startMutation.isError && startMutation.variables?.assignmentId === a.assignmentId && (
                    <p className="text-xs text-red-600">{startMutation.error instanceof Error ? startMutation.error.message : 'Failed to start'}</p>
                  )}
                  <button
                    onClick={() => startMutation.mutate({ orderId: a.orderId, assignmentId: a.assignmentId })}
                    disabled={startMutation.isPending}
                    className="btn-success w-full py-3 text-base font-bold rounded-lg active:scale-[0.98] transition-transform"
                  >
                    {startMutation.isPending && startMutation.variables?.assignmentId === a.assignmentId ? 'Starting…' : 'START WORK'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* My other live jobs */}
        {activeJobs.length > 1 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">My Other Active Jobs</h2>
            </div>
            <div className="card-body p-0">
              {activeJobs.slice(1).map((a) => (
                <div key={a.assignmentId} className="px-5 py-3 border-b border-slate-100 last:border-0 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-bold font-mono text-slate-900">{a.ticketNumber ?? '—'}</span>
                    <span className="text-sm text-slate-500 ml-2">{a.services.join(', ')}</span>
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
