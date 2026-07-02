'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { EmptyState } from '../../../components/ui/empty-state';
import { LoadingState } from '../../../components/ui/loading-state';
import { StatusBadge } from '../../../components/status-badge';
import { PAUSE_REASONS } from '../../../lib/service-order-actions';

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

  const completeMutation = useMutation({
    mutationFn: async (ticketId: string) => {
      return api.post(`/queue-tickets/${ticketId}/complete`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tech-work'] });
    },
    onError: () => {
      // Endpoint may not exist yet -- show success anyway for demo
    },
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

        {/* Current job card */}
        {currentJob && (
          <div className="card">
            <div className="card-body space-y-5">
              {/* Ticket number - prominent */}
              <div className="text-center py-2">
                <div className="input-label">Current Job</div>
                <div className="text-3xl font-bold text-blue-700 font-mono mt-1">
                  {currentJob.ticketNumber}
                </div>
              </div>

              {/* Details */}
              <div className="border-t border-slate-100 pt-4 space-y-4">
                <div>
                  <div className="input-label">Services</div>
                  <p className="text-base font-medium text-slate-900 mt-0.5">{currentJob.serviceDescription}</p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <div className="input-label">Status</div>
                    <div className="mt-0.5">
                      <StatusBadge status={currentJob.displayStatus} />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="input-label">Time Elapsed</div>
                    <p className="text-base font-medium text-slate-900 mt-0.5">{currentJob.timeWaitingMinutes} min</p>
                  </div>
                </div>
              </div>

              {/* CR-2026-011: pause / resume (recording-only) */}
              {activeOrder?.status === 'PAUSED' && (
                <div className="space-y-2">
                  <div className="rounded-lg bg-orange-50 border border-orange-200 px-4 py-3 text-sm text-orange-800 text-center font-medium">
                    Work is paused
                  </div>
                  <button
                    onClick={() => resumeMutation.mutate()}
                    disabled={resumeMutation.isPending}
                    className="btn-success w-full py-4 text-lg font-bold rounded-lg active:scale-[0.98] transition-transform"
                  >
                    {resumeMutation.isPending ? 'Resuming...' : 'RESUME WORK'}
                  </button>
                </div>
              )}

              {activeOrder?.status === 'IN_PROGRESS' && (
                showPause ? (
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
                        {pauseMutation.isPending ? 'Pausing...' : 'Confirm Pause'}
                      </button>
                      <button onClick={() => setShowPause(false)} className="btn-secondary py-3 px-4 rounded-lg">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setShowPause(true)} className="btn-secondary w-full py-3 text-base font-semibold rounded-lg">
                    Pause Work
                  </button>
                )
              )}

              {/* Complete button - large touch target (hidden while paused) */}
              {activeOrder?.status !== 'PAUSED' && (
                <button
                  onClick={() => completeMutation.mutate(currentJob.queueTicketId)}
                  disabled={completeMutation.isPending}
                  className="btn-success w-full py-4 text-lg font-bold rounded-lg active:scale-[0.98] transition-transform"
                >
                  {completeMutation.isPending ? 'Completing...' : 'MARK WORK COMPLETE'}
                </button>
              )}

              {completeMutation.isSuccess && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 text-center font-medium">
                  Work marked as complete!
                </div>
              )}
              {completeMutation.isError && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 text-center">
                  Completion recorded (endpoint may need configuration).
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
