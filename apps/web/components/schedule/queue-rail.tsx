'use client';

import Link from 'next/link';
import { StatusBadge } from '../status-badge';

interface QueueRailItem {
  ticketId: string;
  serviceVisitId: string;
  ticketNumber: string;
  customerName: string;
  customerId: string;
  vehiclePlate: string;
  vehicleId: string;
  vehicleWeightClass: string | null;
  services: string;
  sourceType: string;
  waitMinutes: number;
  partsReadiness: string;
  readyForDispatch: boolean;
  blockedReason: string | null;
  fifoPosition: number | null;
  displayStatus: string;
  requiredResourceTypes: string[];
}

interface ReadyVisit {
  serviceVisitId: string;
  ticketNumber: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  vehiclePlate: string;
}

interface Props {
  queueItems: QueueRailItem[];
  readyForPickup: ReadyVisit[];
  collapsed: boolean;
  onToggle: () => void;
}

export function QueueRail({ queueItems, readyForPickup, collapsed, onToggle }: Props) {
  const ready = queueItems.filter((i) => i.readyForDispatch && i.displayStatus === 'WAITING');
  const waitingResource = queueItems.filter((i) => !i.readyForDispatch && i.displayStatus === 'WAITING');
  const blocked = queueItems.filter((i) => i.displayStatus === 'BLOCKED');

  if (collapsed) {
    return (
      <button
        onClick={onToggle}
        className="w-10 shrink-0 bg-white border-l border-slate-200 flex flex-col items-center justify-center gap-1 hover:bg-slate-50 transition-colors"
        title="Show work queue"
      >
        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        <span className="text-[9px] font-semibold text-slate-500 writing-mode-vertical" style={{ writingMode: 'vertical-rl' }}>
          Queue ({queueItems.length})
        </span>
      </button>
    );
  }

  return (
    <div className="w-80 shrink-0 bg-white border-l border-slate-200 flex flex-col overflow-hidden">
      {/* Rail header */}
      <div className="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between shrink-0">
        <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">Work Queue</h3>
        <button onClick={onToggle} className="text-slate-400 hover:text-slate-600 transition-colors" title="Collapse">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto">
        <RailSection title="Ready to Assign" count={ready.length} color="emerald" items={ready} />
        <RailSection title="Waiting for Resource" count={waitingResource.length} color="amber" items={waitingResource} />
        <RailSection title="Blocked" count={blocked.length} color="red" items={blocked} />

        {/* Pickup section */}
        {readyForPickup.length > 0 && (
          <div className="border-t border-slate-100">
            <div className="px-3 py-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Ready for Collection</span>
              <span className="text-[10px] bg-green-100 text-green-700 px-1.5 rounded-full font-semibold">{readyForPickup.length}</span>
            </div>
            <div className="px-2 pb-2 space-y-1.5">
              {readyForPickup.map((v) => (
                <div key={v.serviceVisitId} className="bg-green-50 border border-green-200 rounded-md px-2.5 py-2">
                  <div className="text-[10px] font-bold font-mono text-green-800">{v.ticketNumber}</div>
                  <div className="text-[10px] text-green-700 truncate">{v.customerName} · {v.vehiclePlate}</div>
                  <div className="text-[9px] text-green-600 mt-0.5">{v.customerPhone}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {queueItems.length === 0 && readyForPickup.length === 0 && (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-slate-400">No items in queue</p>
          </div>
        )}
      </div>
    </div>
  );
}

function RailSection({ title, count, color, items }: { title: string; count: number; color: string; items: QueueRailItem[] }) {
  if (count === 0) return null;

  const dotColor = color === 'emerald' ? 'bg-emerald-500' : color === 'amber' ? 'bg-amber-500' : 'bg-red-500';
  const badgeBg = color === 'emerald' ? 'bg-emerald-100 text-emerald-700' : color === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';

  return (
    <div className="border-t border-slate-100 first:border-t-0">
      <div className="px-3 py-2 flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{title}</span>
        <span className={`text-[10px] px-1.5 rounded-full font-semibold ${badgeBg}`}>{count}</span>
      </div>
      <div className="px-2 pb-2 space-y-1.5">
        {items.map((item) => (
          <QueueCard key={item.ticketId} item={item} />
        ))}
      </div>
    </div>
  );
}

function QueueCard({ item }: { item: QueueRailItem }) {
  return (
    <div className="bg-white border border-slate-200 rounded-md px-2.5 py-2 hover:border-slate-300 transition-colors">
      <div className="flex items-center justify-between mb-1">
        <Link href={`/queue/${item.ticketId}`} className="text-[10px] font-bold font-mono text-blue-700 hover:underline">
          {item.ticketNumber}
        </Link>
        <div className="flex items-center gap-1">
          {item.fifoPosition != null && (
            <span className="text-[9px] bg-blue-100 text-blue-700 px-1 rounded font-semibold">#{item.fifoPosition}</span>
          )}
          <StatusBadge status={item.displayStatus} />
        </div>
      </div>
      <div className="text-[10px] text-slate-600 truncate">{item.customerName} · {item.vehiclePlate}</div>
      <div className="text-[9px] text-slate-400 truncate mt-0.5">{item.services}</div>
      <div className="flex items-center gap-2 mt-1.5 text-[9px]">
        <span className="text-slate-500">{item.waitMinutes}m wait</span>
        <span className={`px-1 rounded ${item.sourceType === 'APPOINTMENT' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>
          {item.sourceType === 'APPOINTMENT' ? 'Appt' : 'Walk'}
        </span>
        {item.partsReadiness === 'REQUIRED_NOT_READY' && (
          <span className="px-1 rounded bg-red-50 text-red-600">Parts</span>
        )}
        {item.blockedReason && (
          <span className="text-red-500 truncate">{item.blockedReason}</span>
        )}
      </div>
      {/* Quick action links */}
      <div className="flex items-center gap-2 mt-1.5">
        <Link href={`/customers/${item.customerId}`} className="text-[9px] text-blue-600 hover:underline">Customer</Link>
        <Link href={`/vehicles/${item.vehicleId}`} className="text-[9px] text-blue-600 hover:underline">Vehicle</Link>
      </div>
    </div>
  );
}
