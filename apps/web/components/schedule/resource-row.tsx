'use client';

import { TimelineEvent, TimelineEventData } from './timeline-event';

interface ResourceData {
  id: string;
  code: string;
  name: string;
  category: string;
  capabilities: string[];
}

interface Props {
  resource: ResourceData;
  events: TimelineEventData[];
  openMinutes: number;
  closeMinutes: number;
  pxPerMinute: number;
  labelColumnWidth: number;
  onEventClick?: (event: TimelineEventData) => void;
}

// Event type priority for z-index layering
const Z_INDEX: Record<string, number> = {
  ACTIVE_WORK: 12,
  BLOCKED: 11,
  RESERVATION: 10,
  COMPLETED: 9,
};

function categoryIcon(category: string) {
  if (category === 'OVERFLOW') return '◇';
  if (category === 'LIGHT_SLOT') return '△';
  return '■';
}

export function ResourceRow({ resource, events, openMinutes, closeMinutes, pxPerMinute, labelColumnWidth, onEventClick }: Props) {
  const totalMinutes = closeMinutes - openMinutes;
  const totalWidth = totalMinutes * pxPerMinute;

  function timeToPercent(isoTime: string): number {
    const d = new Date(isoTime);
    const minutes = d.getHours() * 60 + d.getMinutes();
    const clamped = Math.max(openMinutes, Math.min(closeMinutes, minutes));
    return ((clamped - openMinutes) / totalMinutes) * 100;
  }

  function durationPercent(start: string, end: string | null): number {
    const startPct = timeToPercent(start);
    let endPct: number;
    if (end) {
      endPct = timeToPercent(end);
    } else {
      // No end time — extend to current time
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const clampedNow = Math.max(openMinutes, Math.min(closeMinutes, nowMin));
      endPct = ((clampedNow - openMinutes) / totalMinutes) * 100;
    }
    return Math.max(endPct - startPct, 1.5); // minimum visible width
  }

  // Generate hour grid lines
  const hourLines: number[] = [];
  const startHour = Math.ceil(openMinutes / 60);
  const endHour = Math.floor(closeMinutes / 60);
  for (let h = startHour; h <= endHour; h++) {
    hourLines.push((h * 60 - openMinutes) * pxPerMinute);
  }

  return (
    <div className="flex border-b border-slate-100 hover:bg-slate-50/30 transition-colors group" style={{ minHeight: '44px' }}>
      {/* Resource label — sticky left */}
      <div
        className="shrink-0 sticky left-0 z-10 bg-white group-hover:bg-slate-50/80 border-r border-slate-200 px-3 py-2 flex items-center gap-2"
        style={{ width: `${labelColumnWidth}px` }}
      >
        <span className="text-[10px] text-slate-400">{categoryIcon(resource.category)}</span>
        <div className="min-w-0">
          <div className="text-xs font-bold font-mono text-slate-700 truncate">{resource.code}</div>
          {resource.capabilities.length > 0 && (
            <div className="flex gap-1 mt-0.5">
              {resource.capabilities.slice(0, 2).map((cap) => (
                <span key={cap} className="text-[8px] bg-slate-100 text-slate-500 px-1 rounded">{cap}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Timeline area */}
      <div className="relative" style={{ width: `${totalWidth}px`, minHeight: '44px' }}>
        {/* Hour gridlines */}
        {hourLines.map((left, i) => (
          <div key={i} className="absolute top-0 bottom-0 w-px bg-slate-100" style={{ left: `${left}px` }} />
        ))}

        {/* Events */}
        {events.map((evt) => (
          <TimelineEvent
            key={evt.id}
            event={evt}
            leftPercent={timeToPercent(evt.startTime)}
            widthPercent={durationPercent(evt.startTime, evt.endTime)}
            zIndex={Z_INDEX[evt.type] ?? 10}
            onClick={onEventClick}
          />
        ))}
      </div>
    </div>
  );
}
