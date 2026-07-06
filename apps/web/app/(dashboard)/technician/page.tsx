'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { EmptyState } from '../../../components/ui/empty-state';
import { LoadingState } from '../../../components/ui/loading-state';
import { StatusBadge } from '../../../components/status-badge';
import { PAUSE_REASONS } from '../../../lib/service-order-actions';

// CR-2026-073 — H:MM:SS for the live work timers.
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

interface QueueItem {
  queueTicketId: string;
  ticketNumber: string;
  fifoPosition: number | null;
  displayStatus: string;
  serviceDescription: string;
  timeWaitingMinutes: number;
}

// CR-2026-069 — the logged-in technician's not-yet-started assignments.
interface MyAssignment {
  assignmentId: string;
  orderId: string;
  ticketNumber: string | null;
  customerName: string;
  vehicle: string;
  plate: string;
  bay: string | null;
  services: string[];
}

export default function TechnicianWorkView() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ items: QueueItem[] }>({
    queryKey: ['tech-work', siteId],
    queryFn: () => api.get(`/queue/board?siteId=${siteId}`),
    refetchInterval: 10000,
  });

  const inServiceItems = data?.items?.filter(
    (item) => item.displayStatus === 'IN_SERVICE' || item.displayStatus === 'CALLED',
  ) ?? [];

  const currentJob = inServiceItems[0] ?? null;

  // CR-2026-011: resolve the current job's active service order (ticket -> visit -> orders)
  const ticketDetailQuery = useQuery<{ serviceVisit: { id: string } }>({
    queryKey: ['tech-ticket', currentJob?.queueTicketId],
    queryFn: () => api.get(`/queue-tickets/${currentJob!.queueTicketId}`),
    enabled: !!currentJob,
  });
  const visitId = ticketDetailQuery.data?.serviceVisit?.id;
  const ordersQuery = useQuery<Array<{ id: string; status: string }>>({
    queryKey: ['tech-orders', visitId],
    queryFn: () => api.get(`/service-orders/by-visit/${visitId}`),
    enabled: !!visitId,
  });
  const activeOrder = ordersQuery.data?.find((o) => o.status === 'IN_PROGRESS' || o.status === 'PAUSED') ?? null;

  const [pauseReason, setPauseReason] = useState<string>(PAUSE_REASONS[0].value);
  const [showPause, setShowPause] = useState(false);
  const invalidateWork = () => {
    queryClient.invalidateQueries({ queryKey: ['tech-orders'] });
    queryClient.invalidateQueries({ queryKey: ['tech-work'] });
  };
  const pauseMutation = useMutation({
    mutationFn: () => api.post(`/service-orders/${activeOrder!.id}/pause`, { reasonCode: pauseReason }),
    onSuccess: () => { invalidateWork(); setShowPause(false); },
  });
  const resumeMutation = useMutation({
    mutationFn: () => api.post(`/service-orders/${activeOrder!.id}/resume`, {}),
    onSuccess: invalidateWork,
  });

  // CR-2026-069 — the technician's assigned-but-not-started orders, and starting them.
  const myAssignmentsQuery = useQuery<MyAssignment[]>({
    queryKey: ['my-assignments'],
    queryFn: () => api.get('/service-orders/mine/assignments'),
    refetchInterval: 10000,
  });
  const startMutation = useMutation({
    mutationFn: ({ orderId, assignmentId }: { orderId: string; assignmentId: string }) =>
      api.post(`/service-orders/${orderId}/assignments/${assignmentId}/start`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-assignments'] });
      invalidateWork();
    },
  });

  // CR-2026-073 — live work timers, ready-for-QC, and the job's inspection.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const workTimingQuery = useQuery<{
    startedAt: string | null; completedAt: string | null; status: string; pausedMs: number; openPauseStartedAt: string | null;
  }>({
    queryKey: ['work-timing', activeOrder?.id],
    queryFn: () => api.get(`/service-orders/${activeOrder!.id}/work-timing`),
    enabled: !!activeOrder,
    refetchInterval: 15000,
  });
  const readyForQcMutation = useMutation({
    mutationFn: () => api.post(`/service-orders/${activeOrder!.id}/ready-for-qc`, {}),
    onSuccess: () => {
      invalidateWork();
      queryClient.invalidateQueries({ queryKey: ['work-timing'] });
    },
  });
  const inspectionsQuery = useQuery<{ items: Array<{ id: string; inspectionNumber: string; status: string }> }>({
    queryKey: ['tech-inspections', visitId],
    queryFn: () => api.get(`/inspections?serviceVisitId=${visitId}`),
    enabled: !!visitId,
  });

  // Timer math: elapsed since start, and ACTUAL working time (elapsed − paused).
  const timing = workTimingQuery.data;
  const startedMs = timing?.startedAt ? new Date(timing.startedAt).getTime() : null;
  const openPauseMs = timing?.openPauseStartedAt ? now - new Date(timing.openPauseStartedAt).getTime() : 0;
  const elapsedMs = startedMs ? now - startedMs : 0;
  const workingMs = startedMs ? elapsedMs - (timing?.pausedMs ?? 0) - openPauseMs : 0;

  if (isLoading) {
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
        {/* Header */}
        <PageHeader
          title="My Work"
          subtitle="Technician View"
        />

        {/* CR-2026-069 — assigned to me, ready to start (the mechanic starts the work) */}
        {(myAssignmentsQuery.data ?? []).length > 0 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">Ready to Start ({myAssignmentsQuery.data!.length})</h2>
            </div>
            <div className="card-body p-0">
              {myAssignmentsQuery.data!.map((a) => (
                <div key={a.assignmentId} className="px-5 py-4 border-b border-slate-100 last:border-0 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold font-mono text-blue-700">{a.ticketNumber ?? '—'}</span>
                    {a.bay && <span className="badge bg-slate-100 text-slate-600 text-[10px]">Bay {a.bay}</span>}
                  </div>
                  <p className="text-sm text-slate-700">{a.customerName} · {a.vehicle} ({a.plate})</p>
                  <p className="text-xs text-slate-500">{a.services.join(', ')}</p>
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

        {/* No active job */}
        {!currentJob && (myAssignmentsQuery.data ?? []).length === 0 && (
          <EmptyState
            icon={
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
            title="No Active Assignment"
            description="Waiting for next dispatch..."
          />
        )}

        {/* Current job card (CR-2026-073) */}
        {currentJob && (
          <div className="card overflow-hidden">
            {/* Ticket header */}
            <div className="bg-blue-600 text-white px-5 py-4 text-center">
              <div className="text-[11px] uppercase tracking-wider text-blue-100">Current Job</div>
              <div className="text-3xl font-bold font-mono mt-0.5">{currentJob.ticketNumber}</div>
            </div>

            <div className="card-body space-y-4">
              {/* Live timers */}
              {startedMs ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-center">
                      <div className="input-label">Elapsed</div>
                      <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 mt-0.5">{fmtClock(elapsedMs)}</div>
                    </div>
                    <div className={`rounded-xl border p-3 text-center ${timing?.status === 'PAUSED' ? 'bg-orange-50 border-orange-200' : 'bg-emerald-50 border-emerald-200'}`}>
                      <div className="input-label">Working{timing?.status === 'PAUSED' ? ' (paused)' : ''}</div>
                      <div className={`text-2xl font-bold font-mono tabular-nums mt-0.5 ${timing?.status === 'PAUSED' ? 'text-orange-700' : 'text-emerald-700'}`}>{fmtClock(workingMs)}</div>
                    </div>
                  </div>
                  {timing?.startedAt && <p className="text-[11px] text-slate-400 text-center">Started at {fmtTime(timing.startedAt)}</p>}
                </>
              ) : (
                <div className="text-center">
                  <StatusBadge status={currentJob.displayStatus} />
                </div>
              )}

              {/* Services */}
              <div>
                <div className="input-label">Services</div>
                <p className="text-base font-medium text-slate-900 mt-0.5">{currentJob.serviceDescription}</p>
              </div>

              {/* Vehicle inspection for this job */}
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

              {/* Paused → Resume only */}
              {activeOrder?.status === 'PAUSED' && (
                <div className="space-y-2">
                  <div className="rounded-lg bg-orange-50 border border-orange-200 px-4 py-2.5 text-sm text-orange-800 text-center font-medium">
                    Work is paused
                  </div>
                  <button
                    onClick={() => resumeMutation.mutate()}
                    disabled={resumeMutation.isPending}
                    className="btn-success w-full py-4 text-lg font-bold rounded-lg active:scale-[0.98] transition-transform"
                  >
                    {resumeMutation.isPending ? 'Resuming…' : 'RESUME WORK'}
                  </button>
                </div>
              )}

              {/* In progress → Pause + Ready for QC */}
              {activeOrder?.status === 'IN_PROGRESS' && (
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
                    {readyForQcMutation.isPending ? 'Sending…' : 'READY FOR QC'}
                  </button>
                  <p className="text-[11px] text-slate-400 text-center">Marks your work finished and notifies the manager for a quality check.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Other active jobs */}
        {inServiceItems.length > 1 && (
          <div className="card">
            <div className="card-header">
              <h2 className="text-sm font-semibold text-slate-900">Other Active Jobs</h2>
            </div>
            <div className="card-body p-0">
              {inServiceItems.slice(1).map((item) => (
                <div key={item.queueTicketId} className="px-5 py-3 border-b border-slate-100 last:border-0 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-bold font-mono text-slate-900">{item.ticketNumber}</span>
                    <span className="text-sm text-slate-500 ml-2">{item.serviceDescription}</span>
                  </div>
                  <StatusBadge status={item.displayStatus} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
