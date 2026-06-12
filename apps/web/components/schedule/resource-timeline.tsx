'use client';

import { useRef } from 'react';
import { TimeHeader } from './time-header';
import { ResourceRow } from './resource-row';
import { CurrentTimeIndicator } from './current-time-indicator';
import { TimelineEventData } from './timeline-event';
import { AppointmentsLane, ApptBlock, HoldBlock } from './appointments-lane';

interface ResourceData {
  id: string;
  code: string;
  name: string;
  category: string;
  maxWeight: string | null;
  capabilities: string[];
}

interface Props {
  resources: ResourceData[];
  events: TimelineEventData[];
  operatingHours: { open: string; close: string } | null;
  date: string;
  zoom: 'compact' | 'standard' | 'detailed';
  onEventClick?: (event: TimelineEventData) => void;
  // CR-2026-025 — appointments lane (not bay-bound; shown on its own time-aligned row)
  appointments?: ApptBlock[];
  onAppointmentClick?: (id: string) => void;
  onEmptySlotClick?: (time: string) => void;
  // CR-2026-026 — advisory holds rendered on the same lane
  holds?: HoldBlock[];
  onHoldClick?: (id: string) => void;
}

const ZOOM_PX: Record<string, number> = {
  compact: 2.5,
  standard: 4,
  detailed: 6,
};

const LABEL_WIDTH = 150;

const GROUP_ORDER = ['BAY', 'OVERFLOW', 'LIGHT_SLOT'] as const;
const GROUP_LABELS: Record<string, string> = {
  BAY: 'Service Bays',
  OVERFLOW: 'Overflow Slots',
  LIGHT_SLOT: 'Light Tasks',
};

export function ResourceTimeline({ resources, events, operatingHours, date, zoom, onEventClick, appointments, onAppointmentClick, onEmptySlotClick, holds, onHoldClick }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  if (!operatingHours) {
    return (
      <div className="card flex items-center justify-center py-16 text-sm text-slate-500">
        Closed — no operating hours for this date
      </div>
    );
  }

  const [openH, openM] = operatingHours.open.split(':').map(Number);
  const [closeH, closeM] = operatingHours.close.split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  const pxPerMinute = ZOOM_PX[zoom] ?? 4;
  const totalWidth = (closeMinutes - openMinutes) * pxPerMinute;
  const isToday = date === new Date().toISOString().split('T')[0];

  // Group resources
  const grouped = new Map<string, ResourceData[]>();
  for (const cat of GROUP_ORDER) {
    const items = resources.filter((r) => r.category === cat);
    if (items.length > 0) grouped.set(cat, items);
  }

  // Index events by resourceId
  const eventsByResource = new Map<string, TimelineEventData[]>();
  for (const evt of events) {
    if (!evt.resourceId) continue;
    const arr = eventsByResource.get(evt.resourceId) ?? [];
    arr.push(evt);
    eventsByResource.set(evt.resourceId, arr);
  }

  return (
    <div className="card overflow-hidden flex flex-col h-full">
      {/* Legend bar */}
      <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-4 text-[10px] bg-white shrink-0">
        <span className="text-slate-500 font-medium">Legend:</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-blue-200 border border-blue-300" /> Reserved</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-amber-200 border border-amber-400" /> Active</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-red-200 border border-red-300" /> Blocked</span>
        <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-slate-200 border border-slate-300" /> Done</span>
        {isToday && <span className="flex items-center gap-1"><span className="w-px h-3 bg-red-500" /> Now</span>}
      </div>

      {/* Scrollable timeline */}
      <div ref={scrollRef} className="flex-1 overflow-auto relative">
        {/* Time header */}
        <TimeHeader
          openMinutes={openMinutes}
          closeMinutes={closeMinutes}
          pxPerMinute={pxPerMinute}
          labelColumnWidth={LABEL_WIDTH}
        />

        {/* Appointments lane (time-aligned; not bay-bound) + advisory holds */}
        {(appointments || onEmptySlotClick) && (
          <AppointmentsLane
            appointments={appointments ?? []}
            openMinutes={openMinutes}
            closeMinutes={closeMinutes}
            pxPerMinute={pxPerMinute}
            labelColumnWidth={LABEL_WIDTH}
            onAppointmentClick={onAppointmentClick}
            onEmptySlotClick={onEmptySlotClick}
            holds={holds}
            onHoldClick={onHoldClick}
          />
        )}

        {/* Resource groups */}
        {Array.from(grouped.entries()).map(([cat, groupResources]) => (
          <div key={cat}>
            {/* Group header */}
            <div className="flex sticky top-7 z-[11] bg-slate-50/95 backdrop-blur-sm border-b border-slate-200">
              <div
                className="shrink-0 sticky left-0 z-10 bg-slate-50/95 border-r border-slate-200 px-3 py-1.5"
                style={{ width: `${LABEL_WIDTH}px` }}
              >
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                  {GROUP_LABELS[cat] ?? cat}
                </span>
              </div>
              <div style={{ width: `${totalWidth}px` }} />
            </div>

            {/* Resource rows */}
            {groupResources.map((resource) => (
              <ResourceRow
                key={resource.id}
                resource={resource}
                events={eventsByResource.get(resource.id) ?? []}
                openMinutes={openMinutes}
                closeMinutes={closeMinutes}
                pxPerMinute={pxPerMinute}
                labelColumnWidth={LABEL_WIDTH}
                onEventClick={onEventClick}
              />
            ))}
          </div>
        ))}

        {/* Current time indicator — constrained to timeline grid area only (below header) */}
        {isToday && (
          <div
            className="absolute bottom-0 pointer-events-none"
            style={{ top: '28px', left: `${LABEL_WIDTH}px`, width: `${totalWidth}px` }}
          >
            <CurrentTimeIndicator
              openMinutes={openMinutes}
              closeMinutes={closeMinutes}
              pxPerMinute={pxPerMinute}
              isToday={isToday}
            />
          </div>
        )}

        {/* Empty state if no resources */}
        {resources.length === 0 && (
          <div className="py-16 text-center text-sm text-slate-500">
            No resources configured for this site
          </div>
        )}
      </div>
    </div>
  );
}
