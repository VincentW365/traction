'use client';

import { useQuery } from '@tanstack/react-query';
import { useQueueSocket } from '../../../hooks/use-queue-socket';
import { fmtEtaWindow, type EtaView } from '../../../lib/eta-format';
import Link from 'next/link';
import { api } from '../../../lib/api-client';
import { StatusBadge } from '../../../components/status-badge';
import { useSiteId } from '../../../hooks/use-site';
import { PickupNotificationPanel } from '../../../components/pickup-notification-panel';
import { PageHeader } from '../../../components/ui/page-header';
import { EmptyState } from '../../../components/ui/empty-state';
import { LoadingState } from '../../../components/ui/loading-state';
import { StatCard } from '../../../components/ui/stat-card';

/* ---------- Types (FIFO v2) ---------- */

interface QueueItem {
  priorityClass: string | null;
  queueTicketId: string;
  ticketNumber: string;
  fifoPosition: number | null;
  displayStatus: string;
  // CR-2026-084 — QueueDisplayStatus cannot express QC or "ready for pickup", so the
  // board also carries the visit's own status for an accurate lifecycle breakdown.
  visitStatus?: string;
  sourceType: string;
  blockedReason: string | null;
  readyForDispatch: boolean;
  partsReadiness: string;
  estimatedWaitMinutes: number | null;
  serviceDescription: string;
  timeWaitingMinutes: number;
  // CR-2026-105b — the one persisted estimate (replaces the rank × average guess).
  eta: EtaView;
  overrideActive: boolean;
  overrideReasonCode: string | null;
}

interface QueueBoard {
  siteId: string;
  generatedAt: string;
  items: QueueItem[];
}

/* ---------- Helpers ---------- */

function formatWait(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return '--';
  if (minutes < 1) return '<1 min';
  return `${Math.round(minutes)} min`;
}

function partsLabel(readiness: string): { text: string; className: string } | null {
  if (readiness === 'READY') return { text: 'Parts ready', className: 'text-emerald-600' };
  if (readiness === 'UNCONFIRMED') return { text: 'Parts unconfirmed', className: 'text-amber-600' };
  if (readiness === 'REQUIRED_NOT_READY') return { text: 'Parts not ready', className: 'text-red-600 font-medium' };
  return null;
}

function readinessDot(item: QueueItem): { color: string; title: string } {
  if (item.readyForDispatch) return { color: 'bg-emerald-500', title: 'Ready for dispatch' };
  if (item.displayStatus === 'BLOCKED') return { color: 'bg-red-500', title: 'Blocked' };
  return { color: 'bg-amber-400', title: 'Waiting for resource' };
}

/* ---------- Component ---------- */

export default function QueueBoardPage() {
  const siteId = useSiteId();
  // CR-2026-105b — refresh the moment the queue/ETA republishes (polling stays as fallback).
  useQueueSocket(siteId);

  const boardQuery = useQuery({
    queryKey: ['queue-board', siteId],
    queryFn: () => api.get<QueueBoard>(`/queue/board?siteId=${siteId}`),
    refetchInterval: 5000,
  });

  const readyQuery = useQuery<Array<{
    serviceVisitId: string; ticketNumber: string; customerName: string;
    customerPhone: string; customerEmail: string | null;
    vehiclePlate: string; vehicleDescription: string;
  }>>({
    queryKey: ['ready-for-pickup', siteId],
    queryFn: () => api.get(`/queue/ready-for-pickup?siteId=${siteId}`),
    refetchInterval: 10000,
  });

  const items = boardQuery.data?.items ?? [];
  const activeItems = items.filter((i) => i.displayStatus !== 'BLOCKED');
  const blockedItems = items.filter((i) => i.displayStatus === 'BLOCKED');

  // CR-2026-084 — a car that is being worked on is not "waiting for a bay"; it has
  // one. Before the ticket status was synced this could never happen, so the old
  // filters never had to exclude it.
  const inServiceItems = items.filter(
    (i) => i.displayStatus === 'IN_SERVICE' || i.visitStatus === 'IN_SERVICE' || i.visitStatus === 'QC',
  );
  const inServiceIds = new Set(inServiceItems.map((i) => i.queueTicketId));

  const readyCount = items.filter((i) => i.readyForDispatch).length;
  const waitingForBayCount = activeItems.filter(
    (i) => !i.readyForDispatch && i.displayStatus !== 'BLOCKED' && !inServiceIds.has(i.queueTicketId),
  ).length;
  // CR-2026-078 — surface the rest of the lifecycle on the board: in-service + ready-for-pickup.
  const inServiceCount = inServiceItems.length;
  const readyForPickupCount = readyQuery.data?.length ?? 0;
  // CR-2026-028: total ranked line, for "position N of M" context.
  const rankedTotal = items.filter((i) => i.fifoPosition != null).length;

  return (
    <div className="page-container">
      <PageHeader
        title="Queue Board"
        subtitle="Auto-refreshes every 5s"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Queue Board' },
        ]}
        badge={
          boardQuery.data ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-xs font-mono text-slate-500">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {/* No seconds: the value only updates on refresh, and a frozen
                  seconds digit reads as a broken clock. */}
              {new Date(boardQuery.data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          ) : undefined
        }
      />

      {/* Stat cards — full lifecycle at a glance */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <StatCard value={items.length} label="Total in Queue" color="blue" />
        <StatCard value={waitingForBayCount} label="Waiting for Bay" color="amber" />
        <StatCard value={readyCount} label="Ready to Call" color="green" />
        <StatCard value={inServiceCount} label="In Service" color="blue" />
        <StatCard value={readyForPickupCount} label="Ready for Collection" color="green" />
        <StatCard value={blockedItems.length} label="Blocked" color="red" />
      </div>

      {/* Pickup notification panel */}
      <PickupNotificationPanel readyVisits={readyQuery.data ?? []} />

      {/* Loading */}
      {boardQuery.isLoading && <LoadingState message="Loading queue board..." />}

      {/* Error */}
      {boardQuery.isError && (
        <div className="card border-red-200 bg-red-50 p-5 text-center">
          <p className="text-sm text-red-700 font-medium">Failed to load queue board. Retrying...</p>
        </div>
      )}

      {/* Empty */}
      {boardQuery.data && items.length === 0 && (
        <EmptyState
          title="No customers in queue"
          description="Checked-in customers will appear here automatically."
          icon={
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          }
        />
      )}

      {/* Active queue table */}
      {activeItems.length > 0 && (
        <div className="table-container mb-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="table-header">
                <th className="px-4 py-3 w-14 text-left">#</th>
                <th className="px-4 py-3 text-left">Ticket</th>
                <th className="px-4 py-3 text-left">Source</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Services</th>
                <th className="px-4 py-3 text-right">Waiting</th>
                <th className="px-4 py-3 text-right">Est. start → done</th>
                <th className="px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {activeItems.map((item) => {
                const dot = readinessDot(item);
                const parts = partsLabel(item.partsReadiness);

                return (
                  <tr key={item.queueTicketId} className="table-row">
                    {/* Position */}
                    <td className="px-4 py-3">
                      {item.fifoPosition != null ? (
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-50 text-blue-700 text-xs font-bold border border-blue-200">
                            {item.fifoPosition}
                          </span>
                          <span className="text-[10px] text-slate-400 tabular-nums">of {rankedTotal}</span>
                        </div>
                      ) : (
                        <span className="inline-block w-7 h-7 rounded-full bg-slate-100 animate-pulse" />
                      )}
                    </td>

                    {/* Ticket */}
                    <td className="px-4 py-3">
                      <Link
                        href={`/queue/${item.queueTicketId}`}
                        className="font-mono text-xs font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        {item.ticketNumber}
                      </Link>
                    </td>

                    {/* CR-2026-099 — the engine's priority class, so the order
                        of the line is legible at a glance. */}
                    <td className="px-4 py-3">
                      {(() => {
                        const cls = item.priorityClass;
                        const chip = (text: string, tone: string, title: string) => (
                          <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${tone}`}>{text}</span>
                        );
                        if (item.overrideActive) return chip('Pinned', 'bg-purple-50 text-purple-700 border-purple-200', 'Manager override holds this position');
                        switch (cls) {
                          case 'APPT_PROTECTED':
                            return chip('Appt · on time', 'bg-emerald-50 text-emerald-700 border-emerald-200', 'Appointment inside its protected window');
                          case 'APPT_LATE_SOFT':
                            return chip('Appt · late', 'bg-amber-50 text-amber-700 border-amber-200', 'Late appointment — soft priority with a lateness penalty');
                          case 'MISSED_APPOINTMENT':
                            return chip('Missed appt', 'bg-red-50 text-red-700 border-red-200', 'Arrived past the missed threshold — ranked as a walk-in');
                          case 'WALKIN_FASTTRACK':
                            return chip('Fast track', 'bg-cyan-50 text-cyan-700 border-cyan-200', 'All quick services — fast-track weighting');
                          default:
                            return item.sourceType === 'APPOINTMENT'
                              ? chip('Appt', 'bg-emerald-50 text-emerald-700 border-emerald-200', 'Appointment')
                              : chip('Walk-in', 'bg-blue-50 text-blue-700 border-blue-200', 'Walk-in, ranked by arrival and wait time');
                        }
                      })()}
                    </td>

                    {/* Status + readiness dot + parts info */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${dot.color}`} title={dot.title} />
                        <StatusBadge status={item.displayStatus} />
                      </div>
                      {parts && (
                        <div className={`text-[10px] mt-1 ml-4 ${parts.className}`}>
                          {parts.text}
                        </div>
                      )}
                    </td>

                    {/* Services */}
                    <td className="px-4 py-3 text-slate-600 max-w-[200px] truncate" title={item.serviceDescription}>
                      {item.serviceDescription}
                    </td>

                    {/* Time waiting */}
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-xs font-medium text-slate-700">
                        {formatWait(item.timeWaitingMinutes)}
                      </span>
                    </td>

                    {/* Estimated start → done — CR-2026-105b: the one persisted estimate */}
                    <td className="px-4 py-3 text-right">
                      {item.eta?.estimatedCompletion ? (
                        <span
                          className={`font-mono text-xs ${item.eta.confidence === 'DELAYED' ? 'text-rose-600' : item.eta.confidence === 'AT_RISK' ? 'text-amber-600' : 'text-slate-600'}`}
                          title={item.eta.estimatedStart ? `Est. start ${fmtEtaWindow(item.eta.estimatedStart, item.eta.showRange)} · est. done ${fmtEtaWindow(item.eta.estimatedCompletion, item.eta.showRange)}` : `Est. done ${fmtEtaWindow(item.eta.estimatedCompletion, item.eta.showRange)}`}
                        >
                          {item.eta.estimatedStart ? `${fmtEtaWindow(item.eta.estimatedStart, item.eta.showRange)} → ` : ''}
                          {fmtEtaWindow(item.eta.estimatedCompletion, item.eta.showRange)}
                          {item.eta.confidence === 'DELAYED' ? ' ⚠' : ''}
                        </span>
                      ) : (
                        <span className="font-mono text-xs text-slate-400">
                          {item.eta?.publicState === 'DELAYED' ? 'Delayed' : '--'}
                        </span>
                      )}
                    </td>

                    {/* Override indicator */}
                    <td className="px-4 py-3 text-center">
                      {item.overrideActive && (
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-100 text-violet-700 border border-violet-200 uppercase tracking-wide"
                          title={`Override: ${item.overrideReasonCode}`}
                        >
                          OVR
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Blocked section */}
      {blockedItems.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1 h-4 rounded-full bg-red-500" />
            <h2 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Blocked ({blockedItems.length})
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {blockedItems.map((item) => (
              <div key={item.queueTicketId} className="card border-l-4 border-l-red-400">
                <div className="card-body p-4">
                  <div className="flex items-center justify-between mb-2">
                    <Link
                      href={`/queue/${item.queueTicketId}`}
                      className="font-mono text-xs font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {item.ticketNumber}
                    </Link>
                    <StatusBadge status="BLOCKED" />
                  </div>
                  <p className="text-xs text-red-700 font-medium mb-1">
                    {item.blockedReason || 'Unknown reason'}
                  </p>
                  <p className="text-xs text-slate-500 truncate" title={item.serviceDescription}>
                    {item.serviceDescription}
                  </p>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                    <span className="text-[10px] text-slate-400 uppercase tracking-wide">Waiting</span>
                    <span className="font-mono text-xs text-slate-600">{formatWait(item.timeWaitingMinutes)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
