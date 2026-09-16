'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api-client';

interface ReadyVisit {
  serviceVisitId: string;
  ticketNumber: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  vehiclePlate: string;
  vehicleDescription: string;
}

interface PickupNotificationPanelProps {
  readyVisits: ReadyVisit[];
}

export function PickupNotificationPanel({ readyVisits }: PickupNotificationPanelProps) {
  if (readyVisits.length === 0) return null;

  return (
    <div className="rounded-xl border-2 border-green-400 bg-green-50 p-4 mb-6">
      <h3 className="text-sm font-bold text-green-800 uppercase tracking-wider mb-3">
        Ready for Pickup ({readyVisits.length})
      </h3>
      <div className="space-y-3">
        {readyVisits.map((v) => (
          <PickupCard key={v.serviceVisitId} visit={v} />
        ))}
      </div>
    </div>
  );
}

/** CR-2026-106 — the API's per-channel outcome (docs/121 §C3); never assumed from a 2xx. */
interface PickupSendResult {
  channel: string;
  status: string;
  displayState?: string;
  failureReason?: string | null;
  recipient: string;
}

const OUTCOME_LABEL: Record<string, string> = {
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  TEST_REDIRECTED: 'Test redirected',
  SIMULATED: 'Not delivered (no provider)',
  QUEUED: 'Queued',
  MANUAL: 'Logged',
};

function outcomeOf(r: PickupSendResult): string {
  return r.displayState ?? r.status;
}

function PickupCard({ visit }: { visit: ReadyVisit }) {
  const [outcomes, setOutcomes] = useState<Record<string, PickupSendResult>>({});
  const queryClient = useQueryClient();

  const notifyMutation = useMutation<{ sent: PickupSendResult[] }, unknown, string[]>({
    mutationFn: (channels: string[]) =>
      api.post('/notifications/send-pickup-ready', {
        serviceVisitId: visit.serviceVisitId,
        channels,
      }),
    onSuccess: (res, channels) => {
      setOutcomes((prev) => {
        const next = { ...prev };
        for (const ch of channels) {
          const r = (res?.sent ?? []).find((s) => s.channel === ch);
          // Nothing came back for the channel (e.g. the customer has no email on file):
          // say so instead of claiming a send.
          next[ch] = r ?? { channel: ch, status: 'FAILED', displayState: 'FAILED', failureReason: 'No message was sent for this channel', recipient: '' };
        }
        return next;
      });
    },
  });

  // CR-2026-078 — final close-out: mark picked up, close the visit, clear the queue.
  const pickedUpMutation = useMutation({
    mutationFn: () => api.post(`/queue/pickup/${visit.serviceVisitId}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ready-for-pickup'] });
      queryClient.invalidateQueries({ queryKey: ['queue-board'] });
      queryClient.invalidateQueries({ queryKey: ['dispatch-board'] });
    },
  });

  const smsOutcome = outcomes.SMS ? outcomeOf(outcomes.SMS) : null;
  const emailOutcome = outcomes.EMAIL ? outcomeOf(outcomes.EMAIL) : null;
  const good = (o: string | null) => o === 'SENT' || o === 'DELIVERED' || o === 'TEST_REDIRECTED';
  const smsSent = good(smsOutcome);
  const emailSent = good(emailOutcome);
  const callLogged = !!outcomes.MANUAL_CALL && outcomeOf(outcomes.MANUAL_CALL) !== 'FAILED';
  const notified = smsSent || emailSent || callLogged;
  const failures = Object.values(outcomes).filter((o) => outcomeOf(o) === 'FAILED' || outcomeOf(o) === 'SIMULATED');
  const btnTone = (o: string | null, active: string) =>
    good(o) ? 'bg-green-100 text-green-700 cursor-default' : o === 'FAILED' || o === 'SIMULATED' ? 'bg-red-100 text-red-700 hover:bg-red-200' : active;

  return (
    <div className="bg-white rounded-lg border border-green-200 p-3 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold text-green-700">{visit.ticketNumber}</span>
          <span className="text-sm font-medium text-gray-900 truncate">{visit.customerName}</span>
        </div>
        <div className="text-xs text-gray-500 mt-0.5">
          {visit.vehiclePlate} {visit.vehicleDescription && `- ${visit.vehicleDescription}`}
        </div>
        <div className="text-xs text-gray-400 mt-0.5">
          {visit.customerPhone}
          {visit.customerEmail && ` | ${visit.customerEmail}`}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => notifyMutation.mutate(['SMS'])}
          disabled={smsSent || notifyMutation.isPending}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${btnTone(smsOutcome, 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50')}`}
          title={outcomes.SMS?.failureReason ?? visit.customerPhone}
        >
          {smsOutcome ? `SMS ${OUTCOME_LABEL[smsOutcome] ?? smsOutcome}${smsOutcome === 'FAILED' ? ' — retry' : ''}` : 'SMS'}
        </button>

        {visit.customerEmail && (
          <button
            onClick={() => notifyMutation.mutate(['EMAIL'])}
            disabled={emailSent || notifyMutation.isPending}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${btnTone(emailOutcome, 'bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50')}`}
            title={outcomes.EMAIL?.failureReason ?? visit.customerEmail ?? undefined}
          >
            {emailOutcome ? `Email ${OUTCOME_LABEL[emailOutcome] ?? emailOutcome}${emailOutcome === 'FAILED' ? ' — retry' : ''}` : 'Email'}
          </button>
        )}

        <button
          onClick={() => notifyMutation.mutate(['MANUAL_CALL'])}
          disabled={callLogged || notifyMutation.isPending}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            callLogged
              ? 'bg-green-100 text-green-700 cursor-default'
              : 'bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50'
          }`}
          title={`Call ${visit.customerPhone}`}
        >
          {callLogged ? 'Called' : `Call`}
        </button>

        {/* CR-2026-078 — finish the visit once the customer collects the vehicle */}
        <div className="w-px self-stretch bg-green-200 mx-1" />
        <button
          onClick={() => pickedUpMutation.mutate()}
          disabled={pickedUpMutation.isPending}
          className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors disabled:opacity-50 ${
            notified ? 'bg-emerald-600 text-white hover:bg-emerald-700 ring-2 ring-emerald-300'
                     : 'bg-emerald-600 text-white hover:bg-emerald-700'
          }`}
          title="Customer has collected the vehicle — close the visit"
        >
          {pickedUpMutation.isPending ? 'Closing…' : '✓ Picked Up'}
        </button>
      </div>

      {failures.length > 0 && (
        <p className="basis-full text-xs text-red-700" data-testid="pickup-send-failure">
          {failures.map((f) => `${f.channel}: ${OUTCOME_LABEL[outcomeOf(f)] ?? outcomeOf(f)}${f.failureReason ? ` — ${f.failureReason}` : ''}`).join(' · ')}
        </p>
      )}
      {(notifyMutation.isError || pickedUpMutation.isError) && (
        <span className="text-xs text-red-600">Failed - try again</span>
      )}
    </div>
  );
}
