'use client';

/**
 * CR-2026-096 — Communication History.
 *
 * One table answering "when did we last contact this customer, about what, and
 * did it get through?" — reused on the customer profile, vehicle profile, and
 * visit page (scoped by the filter prop).
 */

import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api-client';

const REASON_LABELS: Record<string, string> = {
  SERVICE_DUE: 'Service Due Reminder',
  QUEUE_CHECKED_IN: 'Checked In',
  QUEUE_WORK_STARTED: 'Work Started',
  QUEUE_UPDATE: 'Service Update',
  PICKUP_READY: 'Ready for Pickup',
  CUSTOM: 'Message',
};

interface HistoryRow {
  id: string;
  createdAt: string;
  sentAt: string | null;
  reason: string | null;
  templateKey: string;
  channel: string;
  recipient: string;
  intendedRecipient: string | null;
  testRouted: boolean;
  simulated: boolean;
  subject: string | null;
  preview: string | null;
  status: string;
  failureReason: string | null;
  sentBy: string | null;
  vehicle: { plateNumber: string; make: string | null; model: string | null } | null;
}

const STATUS_STYLES: Record<string, string> = {
  SENT: 'bg-blue-50 text-blue-700',
  DELIVERED: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-red-50 text-red-700',
  MANUAL: 'bg-slate-100 text-slate-600',
  PENDING: 'bg-amber-50 text-amber-700',
  SCHEDULED: 'bg-amber-50 text-amber-700',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

function reasonLabel(row: HistoryRow): string {
  if (row.reason && REASON_LABELS[row.reason]) return REASON_LABELS[row.reason];
  return row.templateKey.replace(/_/g, ' ');
}

export function CommunicationHistory(props: {
  customerId?: string;
  vehicleId?: string;
  serviceVisitId?: string;
  title?: string;
  /** Render just the table — for embedding inside an existing card. */
  bare?: boolean;
}) {
  const { customerId, vehicleId, serviceVisitId } = props;
  const [openId, setOpenId] = useState<string | null>(null);

  const param = serviceVisitId
    ? `serviceVisitId=${serviceVisitId}`
    : vehicleId
      ? `vehicleId=${vehicleId}`
      : `customerId=${customerId}`;

  const q = useQuery<HistoryRow[]>({
    queryKey: ['notification-history', customerId ?? null, vehicleId ?? null, serviceVisitId ?? null],
    queryFn: () => api.get(`/notifications/history?${param}`),
    enabled: !!(customerId || vehicleId || serviceVisitId),
  });

  const inner = (
    <>
        {q.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (q.data ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">No messages sent yet.</p>
        ) : (
          <div className="table-container border-0 shadow-none">
            <table className="w-full text-sm">
              <thead className="table-header">
                <tr><th>When</th><th>Reason</th><th>Channel</th><th>To</th><th>Status</th><th>Sent by</th></tr>
              </thead>
              <tbody>
                {q.data!.map((n) => (
                  <Fragment key={n.id}>
                    <tr
                      className="table-row cursor-pointer"
                      onClick={() => setOpenId(openId === n.id ? null : n.id)}
                    >
                      <td className="text-xs text-slate-500 whitespace-nowrap">
                        {new Date(n.sentAt ?? n.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="text-slate-700">
                        {reasonLabel(n)}
                        {n.testRouted && <span className="ml-1.5 badge bg-amber-50 text-amber-700 text-[10px]">test</span>}
                        {n.simulated && <span className="ml-1.5 badge bg-slate-100 text-slate-500 text-[10px]">not delivered</span>}
                      </td>
                      <td className="text-xs text-slate-500">{n.channel.replace(/_/g, ' ')}</td>
                      <td className="text-xs text-slate-500 break-all">{n.recipient}</td>
                      <td>
                        <span className={`badge text-[10px] ${STATUS_STYLES[n.status] ?? 'bg-slate-100 text-slate-600'}`}>{n.status}</span>
                      </td>
                      <td className="text-xs text-slate-500">{n.sentBy ?? '—'}</td>
                    </tr>
                    {openId === n.id && (
                      <tr>
                        <td colSpan={6} className="bg-slate-50 px-4 py-3">
                          {n.subject && <p className="text-xs font-semibold text-slate-700 mb-1">{n.subject}</p>}
                          {n.preview && <p className="text-xs text-slate-700 whitespace-pre-wrap">{n.preview}</p>}
                          {n.intendedRecipient && (
                            <p className="text-[11px] text-amber-700 mt-1">
                              Intended: {n.intendedRecipient} · Delivered to test recipient: {n.recipient}
                            </p>
                          )}
                          {n.failureReason && <p className="text-[11px] text-red-600 mt-1">{n.failureReason}</p>}
                          {n.vehicle && (
                            <p className="text-[11px] text-slate-400 mt-1">
                              {[n.vehicle.make, n.vehicle.model].filter(Boolean).join(' ')} {n.vehicle.plateNumber}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </>
  );

  if (props.bare) return <div className="px-4 py-3">{inner}</div>;

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="text-sm font-semibold text-slate-900">{props.title ?? 'Communication History'}</h2>
      </div>
      <div className="card-body">{inner}</div>
    </div>
  );
}
