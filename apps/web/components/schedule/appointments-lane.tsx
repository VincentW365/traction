'use client';

/**
 * Time-aligned "Appointments" lane for the schedule day view (CR-2026-025).
 * Appointments aren't bay-bound until dispatch, so they live on their own lane
 * above the resource rows, positioned on the same time axis. Clicking a block
 * opens the appointment detail modal; clicking empty space proposes creating an
 * appointment at that (15-min-snapped) time.
 */

export interface ApptBlock {
  id: string;
  scheduledStartAt: string;
  scheduledEndAt: string | null;
  status: string;
  customerName: string;
}

interface Props {
  appointments: ApptBlock[];
  openMinutes: number;
  closeMinutes: number;
  pxPerMinute: number;
  labelColumnWidth: number;
  onAppointmentClick?: (id: string) => void;
  onEmptySlotClick?: (time: string) => void; // "HH:MM"
}

// Block color by appointment status.
const STATUS_STYLE: Record<string, string> = {
  CONFIRMED: 'bg-blue-100 border-blue-300 text-blue-800 hover:bg-blue-200',
  DRAFT: 'bg-slate-100 border-slate-300 text-slate-600 hover:bg-slate-200',
  RESCHEDULED: 'bg-amber-100 border-amber-300 text-amber-800 hover:bg-amber-200',
};

const fmt = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function AppointmentsLane({
  appointments,
  openMinutes,
  closeMinutes,
  pxPerMinute,
  labelColumnWidth,
  onAppointmentClick,
  onEmptySlotClick,
}: Props) {
  const totalMinutes = closeMinutes - openMinutes;
  const totalWidth = totalMinutes * pxPerMinute;

  const minutesOf = (iso: string) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
  const toPct = (m: number) => ((Math.max(openMinutes, Math.min(closeMinutes, m)) - openMinutes) / totalMinutes) * 100;

  // Hour gridlines (mirror ResourceRow)
  const hourLines: number[] = [];
  for (let h = Math.ceil(openMinutes / 60); h <= Math.floor(closeMinutes / 60); h++) {
    hourLines.push((h * 60 - openMinutes) * pxPerMinute);
  }

  function handleAreaClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onEmptySlotClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const snapped = Math.round((openMinutes + x / pxPerMinute) / 15) * 15;
    const m = Math.max(openMinutes, Math.min(closeMinutes - 15, snapped));
    onEmptySlotClick(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }

  return (
    <div className="flex border-b border-slate-200 bg-white" style={{ minHeight: '46px' }}>
      {/* Label — sticky left */}
      <div
        className="shrink-0 sticky left-0 z-10 bg-white border-r border-slate-200 px-3 py-2 flex items-center"
        style={{ width: `${labelColumnWidth}px` }}
      >
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Appointments</span>
      </div>

      {/* Timeline area — click empty space to create */}
      <div
        className="relative cursor-copy"
        style={{ width: `${totalWidth}px`, minHeight: '46px' }}
        onClick={handleAreaClick}
        title="Click an empty time to create an appointment"
      >
        {hourLines.map((left, i) => (
          <div key={i} className="absolute top-0 bottom-0 w-px bg-slate-100" style={{ left: `${left}px` }} />
        ))}

        {appointments.map((a) => {
          const startM = minutesOf(a.scheduledStartAt);
          const endM = a.scheduledEndAt ? minutesOf(a.scheduledEndAt) : startM + 30;
          const left = toPct(startM);
          const width = Math.max(toPct(endM) - left, 3);
          return (
            <button
              key={a.id}
              onClick={(e) => { e.stopPropagation(); onAppointmentClick?.(a.id); }}
              className={`absolute top-1 bottom-1 rounded border px-1.5 overflow-hidden text-left transition-colors ${STATUS_STYLE[a.status] ?? STATUS_STYLE.DRAFT}`}
              style={{ left: `${left}%`, width: `${width}%`, minWidth: '54px' }}
              title={`${fmt(a.scheduledStartAt)} — ${a.customerName} (${a.status})`}
            >
              <span className="block text-[10px] font-semibold leading-tight truncate">{fmt(a.scheduledStartAt)}</span>
              <span className="block text-[10px] leading-tight truncate">{a.customerName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
