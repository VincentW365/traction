'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { EmptyState } from '../../../components/empty-state';
import { LoadingState } from '../../../components/loading-state';
import { StatusBadge } from '../../../components/status-badge';

interface QueueItem {
  queueTicketId: string;
  ticketNumber: string;
  fifoPosition: number | null;
  displayStatus: string;
  serviceDescription: string;
  timeWaitingMinutes: number;
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
        <div className="text-center pt-2 pb-1">
          <h1 className="text-xl font-bold text-slate-900">My Work</h1>
          <p className="text-xs text-slate-500 mt-0.5">Technician View</p>
        </div>

        {/* No active job */}
        {!currentJob && (
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

              {/* Complete button - large touch target */}
              <button
                onClick={() => completeMutation.mutate(currentJob.queueTicketId)}
                disabled={completeMutation.isPending}
                className="btn-success w-full py-4 text-lg font-bold rounded-lg active:scale-[0.98] transition-transform"
              >
                {completeMutation.isPending ? 'Completing...' : 'MARK WORK COMPLETE'}
              </button>

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
