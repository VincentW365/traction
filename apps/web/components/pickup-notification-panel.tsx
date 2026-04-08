'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
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

function PickupCard({ visit }: { visit: ReadyVisit }) {
  const [sent, setSent] = useState<string[]>([]);

  const notifyMutation = useMutation({
    mutationFn: (channels: string[]) =>
      api.post('/notifications/send-pickup-ready', {
        serviceVisitId: visit.serviceVisitId,
        channels,
      }),
    onSuccess: (_, channels) => {
      setSent((prev) => [...prev, ...channels]);
    },
  });

  const smsSent = sent.includes('SMS');
  const emailSent = sent.includes('EMAIL');
  const callLogged = sent.includes('MANUAL_CALL');

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
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            smsSent
              ? 'bg-green-100 text-green-700 cursor-default'
              : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
          }`}
          title={visit.customerPhone}
        >
          {smsSent ? 'SMS Sent' : 'SMS'}
        </button>

        {visit.customerEmail && (
          <button
            onClick={() => notifyMutation.mutate(['EMAIL'])}
            disabled={emailSent || notifyMutation.isPending}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              emailSent
                ? 'bg-green-100 text-green-700 cursor-default'
                : 'bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50'
            }`}
          >
            {emailSent ? 'Email Sent' : 'Email'}
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
      </div>

      {notifyMutation.isError && (
        <span className="text-xs text-red-600">Failed - try again</span>
      )}
    </div>
  );
}
