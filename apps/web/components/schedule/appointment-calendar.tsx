'use client';

/**
 * Dedicated day calendar for APPOINTMENTS (separate from the bay/resource timeline).
 * Vertical time axis; overlapping appointments are packed into side-by-side columns
 * so they never visually overlap and each stays individually clickable. Advisory
 * holds are shown in the same packing. Clicking empty space proposes a new
 * appointment at the (15-min-snapped) time.
 */
import { useRef } from 'react';
import type { ApptBlock, HoldBlock, WalkInBlock } from './appointments-lane';

interface Props {
  appointments: ApptBlock[];
  holds?: HoldBlock[];
  walkIns?: WalkInBlock[];
  operatingHours: { open: string; close: string } | null;
  date: string;
  zoom: 'compact' | 'standard' | 'detailed';
  onAppointmentClick?: (id: string) => void;
  onHoldClick?: (id: string) => void;
  onWalkInClick?: (block: WalkInBlock) => void;
  onEmptySlotClick?: (time: string) => void; // "HH:MM"
}

const ZOOM_PX: Record<string, number> = { compact: 0.75, standard: 1.2, detailed: 1.9 }; // px per minute (vertical)
const GUTTER = 60; // hour-label column width

const STATUS_STYLE: Record<string, string> = {
  CONFIRMED: 'bg-blue-100 border-blue-300 text-blue-800 hover:bg-blue-200',
  DRAFT: 'bg-slate-100 border-slate-300 text-slate-600 hover:bg-slate-200',
  RESCHEDULED: 'bg-amber-100 border-amber-300 text-amber-800 hover:bg-amber-200',
};
const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const WALKIN_BLOCK_MIN = 20; // nominal block length for a walk-in (it has only an arrival time)

type Item = { id: string; kind: 'appt' | 'hold' | 'walkin'; start: number; end: number; data: ApptBlock | HoldBlock | WalkInBlock };

/** Greedy interval partitioning: each item gets a column; concurrent items share a
 *  cluster whose column count fixes their widths so nothing overlaps. */
function packColumns(items: Item[]) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const placed: Array<{ item: Item; col: number; cols: number }> = [];
  let group: Array<{ item: Item; col: number; cols: number }> = [];
  let colEnds: number[] = [];
  const flush = () => {
    const cols = Math.max(colEnds.length, 1);
    for (const g of group) g.cols = cols;
    placed.push(...group);
    group = [];
    colEnds = [];
  };
  for (const it of sorted) {
    if (group.length && it.start >= Math.max(...group.map((g) => g.item.end))) flush();
    let col = colEnds.findIndex((e) => e <= it.start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(it.end);
    } else {
      colEnds[col] = it.end;
    }
    group.push({ item: it, col, cols: 0 });
  }
  flush();
  return placed;
}

export function AppointmentCalendar({
  appointments,
  holds = [],
  walkIns = [],
  operatingHours,
  date,
  zoom,
  onAppointmentClick,
  onHoldClick,
  onWalkInClick,
  onEmptySlotClick,
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null);

  if (!operatingHours) {
    return <div className="card flex items-center justify-center py-16 text-sm text-slate-500">Closed — no operating hours for this date</div>;
  }

  const [oH, oM] = operatingHours.open.split(':').map(Number);
  const [cH, cM] = operatingHours.close.split(':').map(Number);
  const openMin = oH * 60 + oM;
  const closeMin = cH * 60 + cM;
  const px = ZOOM_PX[zoom] ?? 1.2;
  const totalH = (closeMin - openMin) * px;
  const minutesOf = (iso: string) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };

  const items: Item[] = [
    ...appointments.map((a) => ({
      id: a.id, kind: 'appt' as const,
      start: minutesOf(a.scheduledStartAt),
      end: a.scheduledEndAt ? minutesOf(a.scheduledEndAt) : minutesOf(a.scheduledStartAt) + 30,
      data: a,
    })),
    ...holds.map((h) => ({ id: h.id, kind: 'hold' as const, start: minutesOf(h.scheduledStartAt), end: minutesOf(h.scheduledEndAt), data: h })),
    ...walkIns
      .filter((w) => w.checkedInAt)
      .map((w) => ({
        id: `walkin-${w.serviceVisitId}`,
        kind: 'walkin' as const,
        start: minutesOf(w.checkedInAt as string),
        end: minutesOf(w.checkedInAt as string) + WALKIN_BLOCK_MIN,
        data: w,
      })),
  ].map((it) => ({ ...it, start: Math.max(openMin, it.start), end: Math.min(closeMin, Math.max(it.end, it.start + 15)) }));

  const placed = packColumns(items);

  const hours: number[] = [];
  for (let h = Math.ceil(openMin / 60); h <= Math.floor(closeMin / 60); h++) hours.push(h);

  const isToday = date === new Date().toISOString().split('T')[0];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showNow = isToday && nowMin >= openMin && nowMin <= closeMin;

  function handleAreaClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onEmptySlotClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const snapped = Math.round((openMin + y / px) / 15) * 15;
    const m = Math.max(openMin, Math.min(closeMin - 15, snapped));
    onEmptySlotClick(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }

  return (
    <div className="card overflow-hidden flex flex-col h-full">
      {/* Legend */}
      <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-4 text-[10px] bg-white shrink-0">
        <span className="text-slate-500 font-medium">Legend:</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-blue-200 border border-blue-300" /> Confirmed</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-slate-200 border border-slate-300" /> Draft</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-amber-200 border border-amber-400" /> Rescheduled</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm border border-dashed border-slate-400 bg-slate-100" /> Held</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-emerald-200 border border-emerald-400" /> Walk-in</span>
        {showNow && <span className="flex items-center gap-1"><span className="w-3 h-px bg-red-500" /> Now</span>}
        <span className="ml-auto text-slate-400">Click an empty time to add</span>
      </div>

      {/* Calendar body */}
      <div className="flex-1 overflow-auto">
        <div className="relative" style={{ height: `${Math.max(totalH, 200)}px` }}>
          {/* Hour gridlines + labels */}
          {hours.map((h) => {
            const top = (h * 60 - openMin) * px;
            const label = `${(h % 12) || 12}${h < 12 ? ' AM' : ' PM'}`;
            return (
              <div key={h} className="absolute left-0 right-0 border-t border-slate-100" style={{ top: `${top}px` }}>
                <span className="absolute -top-2 left-0 pl-2 text-[10px] text-slate-400 bg-white" style={{ width: `${GUTTER}px` }}>{label}</span>
              </div>
            );
          })}

          {/* Empty-slot click area (excludes the gutter) */}
          <div
            ref={areaRef}
            className="absolute cursor-copy"
            style={{ left: `${GUTTER}px`, right: 0, top: 0, height: `${Math.max(totalH, 200)}px` }}
            onClick={handleAreaClick}
            title="Click an empty time to add an appointment"
          />

          {/* Now line */}
          {showNow && (
            <div className="absolute right-0 z-20 pointer-events-none" style={{ top: `${(nowMin - openMin) * px}px`, left: `${GUTTER}px` }}>
              <div className="h-px bg-red-500" />
              <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-red-500" />
            </div>
          )}

          {/* Items (appointments + holds), column-packed so they never overlap */}
          {placed.map(({ item, col, cols }) => {
            const top = (item.start - openMin) * px;
            const height = Math.max((item.end - item.start) * px, 20);
            const frac = col / cols;
            const wfrac = 1 / cols;
            const left = `calc(${GUTTER}px + (100% - ${GUTTER}px) * ${frac})`;
            const width = `calc((100% - ${GUTTER}px) * ${wfrac} - 4px)`;
            if (item.kind === 'hold') {
              const h = item.data as HoldBlock;
              return (
                <button
                  key={item.id}
                  onClick={(e) => { e.stopPropagation(); onHoldClick?.(item.id); }}
                  className="absolute z-10 rounded border border-dashed border-slate-400 bg-slate-100/80 px-1.5 py-0.5 overflow-hidden text-left text-slate-500 hover:bg-slate-200 transition-colors"
                  style={{ top: `${top}px`, height: `${height}px`, left, width }}
                  title={`HELD ${fmt(h.scheduledStartAt)} – ${fmt(h.scheduledEndAt)}${h.label ? ` — ${h.label}` : ''}`}
                >
                  <span className="block text-[10px] font-semibold leading-tight truncate">HELD {fmt(h.scheduledStartAt)}</span>
                  {h.label && <span className="block text-[10px] leading-tight truncate">{h.label}</span>}
                </button>
              );
            }
            if (item.kind === 'walkin') {
              const w = item.data as WalkInBlock;
              return (
                <button
                  key={item.id}
                  onClick={(e) => { e.stopPropagation(); onWalkInClick?.(w); }}
                  className="absolute z-10 rounded border border-emerald-400 bg-emerald-100 text-emerald-800 px-1.5 py-0.5 overflow-hidden text-left hover:bg-emerald-200 transition-colors"
                  style={{ top: `${top}px`, height: `${height}px`, left, width }}
                  title={`Walk-in${w.checkedInAt ? ` ${fmt(w.checkedInAt)}` : ''} — ${w.customerName}${w.ticketNumber ? ` (${w.ticketNumber})` : ''}`}
                >
                  <span className="block text-[10px] font-semibold leading-tight truncate">Walk-in{w.checkedInAt ? ` ${fmt(w.checkedInAt)}` : ''}</span>
                  <span className="block text-[11px] leading-tight truncate">{w.customerName}</span>
                </button>
              );
            }
            const a = item.data as ApptBlock;
            return (
              <button
                key={item.id}
                onClick={(e) => { e.stopPropagation(); onAppointmentClick?.(item.id); }}
                className={`absolute z-10 rounded border px-1.5 py-0.5 overflow-hidden text-left transition-colors ${STATUS_STYLE[a.status] ?? STATUS_STYLE.DRAFT}`}
                style={{ top: `${top}px`, height: `${height}px`, left, width }}
                title={`${fmt(a.scheduledStartAt)}${a.scheduledEndAt ? ` – ${fmt(a.scheduledEndAt)}` : ''} — ${a.customerName} (${a.status})`}
              >
                <span className="block text-[10px] font-semibold leading-tight truncate">{fmt(a.scheduledStartAt)}</span>
                <span className="block text-[11px] leading-tight truncate">{a.customerName}</span>
              </button>
            );
          })}

          {/* Empty state */}
          {placed.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400 pointer-events-none" style={{ paddingLeft: `${GUTTER}px` }}>
              No appointments scheduled — click a time to add one
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
