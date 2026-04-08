'use client';

import { useState } from 'react';

export interface TimelineEventData {
  id: string;
  resourceId: string | null;
  type: 'RESERVATION' | 'ACTIVE_WORK' | 'BLOCKED' | 'COMPLETED';
  startTime: string;
  endTime: string | null;
  ticketNumber: string | null;
  customerName: string;
  vehiclePlate: string;
  services: string;
  sourceType: string;
  status: string;
  technicianName: string | null;
}

const EVENT_STYLES: Record<string, { bg: string; border: string; text: string; label: string }> = {
  RESERVATION: { bg: 'bg-blue-100/80', border: 'border-blue-300', text: 'text-blue-800', label: 'Reserved' },
  ACTIVE_WORK: { bg: 'bg-amber-100', border: 'border-amber-400', text: 'text-amber-900', label: 'In Service' },
  BLOCKED: { bg: 'bg-red-100', border: 'border-red-300', text: 'text-red-800', label: 'Blocked' },
  COMPLETED: { bg: 'bg-slate-100/60', border: 'border-slate-200', text: 'text-slate-400', label: 'Done' },
};

interface Props {
  event: TimelineEventData;
  leftPercent: number;
  widthPercent: number;
  zIndex: number;
  onClick?: (event: TimelineEventData) => void;
}

export function TimelineEvent({ event, leftPercent, widthPercent, zIndex, onClick }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);
  const style = EVENT_STYLES[event.type] ?? EVENT_STYLES.RESERVATION;
  const isLive = event.type === 'ACTIVE_WORK';
  const isCompleted = event.type === 'COMPLETED';

  const startStr = new Date(event.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endStr = event.endTime ? new Date(event.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Now';
  const isNarrow = widthPercent < 5;

  return (
    <div
      className={`absolute top-1 bottom-1 rounded ${style.bg} border ${style.border} ${style.text}
        cursor-pointer overflow-hidden transition-shadow hover:shadow-md hover:z-30
        ${isLive ? 'ring-1 ring-amber-400/50' : ''}
        ${isCompleted ? 'opacity-60' : ''}`}
      style={{
        left: `${leftPercent}%`,
        width: `${Math.max(widthPercent, 1.5)}%`,
        zIndex,
        minWidth: '24px',
      }}
      onClick={() => onClick?.(event)}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Content — hidden if too narrow */}
      {!isNarrow && (
        <div className="px-1.5 py-0.5 h-full flex flex-col justify-center overflow-hidden">
          <div className="text-[10px] font-semibold truncate leading-tight">
            {event.ticketNumber ?? event.customerName}
          </div>
          <div className="text-[9px] truncate opacity-75 leading-tight">
            {event.vehiclePlate} · {event.services.split(',')[0]}
          </div>
        </div>
      )}

      {/* Live pulse indicator */}
      {isLive && (
        <div className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      )}

      {/* Tooltip */}
      {showTooltip && (
        <div className="absolute bottom-full left-0 mb-1 z-50 w-56 p-2.5 bg-slate-900 text-white rounded-lg shadow-xl text-[11px] pointer-events-none">
          <div className="font-semibold text-xs mb-1">{event.customerName}</div>
          <div className="text-slate-300 space-y-0.5">
            <div>{event.vehiclePlate} · {event.sourceType === 'APPOINTMENT' ? 'Appointment' : 'Walk-In'}</div>
            <div>{event.services}</div>
            <div>{startStr} → {endStr}</div>
            {event.ticketNumber && <div className="font-mono text-slate-400">{event.ticketNumber}</div>}
            {event.technicianName && <div>Tech: {event.technicianName}</div>}
            <div className="mt-1 text-[10px] font-medium text-slate-400">{style.label}</div>
          </div>
        </div>
      )}
    </div>
  );
}
