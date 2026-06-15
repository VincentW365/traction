'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { StatCard } from '../../../components/ui/stat-card';
import { LoadingState } from '../../../components/ui/loading-state';
import { ResourceTimeline } from '../../../components/schedule/resource-timeline';
import { QueueRail } from '../../../components/schedule/queue-rail';
import { WeekView } from '../../../components/schedule/week-view';
import { AppointmentCalendar } from '../../../components/schedule/appointment-calendar';
import { TimelineEventData } from '../../../components/schedule/timeline-event';
import { AppointmentDetailModal } from '../../../components/appointment-detail-modal';

// --- Types ---

interface ScheduleDayResponse {
  siteId: string;
  date: string;
  operatingHours: { open: string; close: string } | null;
  resources: Array<{
    id: string; code: string; name: string; category: string;
    maxWeight: string | null; capabilities: string[];
  }>;
  events: TimelineEventData[];
  queueItems: Array<{
    ticketId: string; serviceVisitId: string; ticketNumber: string;
    customerName: string; customerId: string; vehiclePlate: string; vehicleId: string;
    vehicleWeightClass: string | null; services: string; sourceType: string;
    waitMinutes: number; partsReadiness: string; readyForDispatch: boolean;
    blockedReason: string | null; fifoPosition: number | null; displayStatus: string;
    requiredResourceTypes: string[];
  }>;
  readyForPickup: Array<{
    serviceVisitId: string; ticketNumber: string; customerName: string;
    customerPhone: string; customerEmail: string | null; vehiclePlate: string;
  }>;
  stats: { appointments: number; walkIns: number; completed: number; blocked: number };
}

interface ScheduleWeekResponse {
  siteId: string;
  weekStart: string;
  days: Array<{
    date: string; dayName: string;
    operatingHours: { open: string; close: string } | null;
    appointmentCount: number; walkInCount: number; completedCount: number;
    blockedCount: number; resourceUtilization: number; isToday: boolean; isClosed: boolean;
  }>;
}

type ZoomLevel = 'compact' | 'standard' | 'detailed';
type ScheduleView = 'appointments' | 'bays' | 'week';

// --- Helpers ---

function getMonday(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function formatDateShort(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const toHHMM = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// --- Component ---

export default function SchedulePage() {
  const siteId = useSiteId();
  const router = useRouter();
  const queryClient = useQueryClient();
  const today = new Date().toISOString().split('T')[0];

  const [selectedDate, setSelectedDate] = useState(today);
  const [activeView, setActiveView] = useState<ScheduleView>('appointments');
  const isDay = activeView !== 'week'; // appointments + bays are both single-day views
  const [zoom, setZoom] = useState<ZoomLevel>('standard');
  const [railCollapsed, setRailCollapsed] = useState(false);
  // CR-2026-025 — appointment detail modal + "create at time" popover
  const [openApptId, setOpenApptId] = useState<string | null>(null);
  const [createAtTime, setCreateAtTime] = useState<string | null>(null);
  // CR-2026-026 — quick-hold popover state + hold detail modal
  const [openHoldId, setOpenHoldId] = useState<string | null>(null);
  const [holdDuration, setHoldDuration] = useState<number>(30);
  const [holdLabel, setHoldLabel] = useState('');

  // Session-persist zoom
  const setZoomPersist = useCallback((z: ZoomLevel) => {
    setZoom(z);
    try { sessionStorage.setItem('schedule_zoom', z); } catch {}
  }, []);

  // Day schedule query — operating hours, stats (both day views); resources/events (bays).
  const dayQuery = useQuery<ScheduleDayResponse>({
    queryKey: ['schedule-day', siteId, selectedDate],
    queryFn: () => api.get(`/schedule/day?siteId=${siteId}&date=${selectedDate}`),
    refetchInterval: isDay ? 10000 : false,
    enabled: isDay && !!siteId,
  });

  // Week schedule query
  const weekStart = getMonday(selectedDate);
  const weekQuery = useQuery<ScheduleWeekResponse>({
    queryKey: ['schedule-week', siteId, weekStart],
    queryFn: () => api.get(`/schedule/week?siteId=${siteId}&weekStart=${weekStart}`),
    enabled: activeView === 'week' && !!siteId,
  });

  // Appointments for the day → rendered on the dedicated Appointments calendar.
  const apptListQuery = useQuery<Array<{
    id: string; scheduledStartAt: string; scheduledEndAt: string | null; status: string;
    customer: { firstName: string; lastName: string };
  }>>({
    queryKey: ['schedule-appointments', siteId, selectedDate],
    queryFn: () => api.get(`/appointments?siteId=${siteId}&date=${selectedDate}`),
    enabled: activeView === 'appointments' && !!siteId,
    refetchInterval: activeView === 'appointments' ? 10000 : false,
  });
  const apptBlocks = (apptListQuery.data ?? [])
    .filter((a) => ['DRAFT', 'CONFIRMED', 'RESCHEDULED'].includes(a.status))
    .map((a) => ({
      id: a.id,
      scheduledStartAt: a.scheduledStartAt,
      scheduledEndAt: a.scheduledEndAt,
      status: a.status,
      customerName: `${a.customer.firstName} ${a.customer.lastName}`,
    }));

  // CR-2026-026 — advisory holds for the day (ACTIVE only).
  const holdsQuery = useQuery<Array<{ id: string; scheduledStartAt: string; scheduledEndAt: string; label: string | null }>>({
    queryKey: ['schedule-holds', siteId, selectedDate],
    queryFn: () => api.get(`/schedule-holds?siteId=${siteId}&date=${selectedDate}`),
    enabled: activeView === 'appointments' && !!siteId,
    refetchInterval: activeView === 'appointments' ? 10000 : false,
    retry: false, // fail closed (no holds shown) if the role lacks permission
  });
  const holdBlocks = (holdsQuery.data ?? []).map((h) => ({
    id: h.id, scheduledStartAt: h.scheduledStartAt, scheduledEndAt: h.scheduledEndAt, label: h.label,
  }));
  const openHold = (holdsQuery.data ?? []).find((h) => h.id === openHoldId) ?? null;

  const onScheduleChanged = () => {
    queryClient.invalidateQueries({ queryKey: ['schedule-day'] });
    queryClient.invalidateQueries({ queryKey: ['schedule-appointments'] });
    queryClient.invalidateQueries({ queryKey: ['schedule-holds'] });
  };

  const createHoldMutation = useMutation({
    mutationFn: (payload: { scheduledStartAt: string; durationMinutes: number; label?: string }) =>
      api.post('/schedule-holds', { siteId, ...payload }),
    onSuccess: () => { onScheduleChanged(); setCreateAtTime(null); setHoldLabel(''); setHoldDuration(30); },
  });
  const releaseHoldMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/schedule-holds/${id}`),
    onSuccess: () => { onScheduleChanged(); setOpenHoldId(null); },
  });

  function prevDay() {
    const d = new Date(`${selectedDate}T12:00:00`);
    d.setDate(d.getDate() - 1);
    setSelectedDate(d.toISOString().split('T')[0]);
  }
  function nextDay() {
    const d = new Date(`${selectedDate}T12:00:00`);
    d.setDate(d.getDate() + 1);
    setSelectedDate(d.toISOString().split('T')[0]);
  }
  function goToday() {
    setSelectedDate(today);
  }

  function handleEventClick(event: TimelineEventData) {
    if (event.ticketNumber) {
      router.push(`/queue/${event.id.replace(/^(res-|occ-|done-)/, '')}`);
    }
  }

  function handleWeekDaySelect(date: string) {
    setSelectedDate(date);
    setActiveView('appointments');
  }

  const data = dayQuery.data;
  const stats = data?.stats;

  const VIEWS: Array<[ScheduleView, string]> = [
    ['appointments', 'Appointments'],
    ['bays', 'Bays'],
    ['week', 'Week'],
  ];

  return (
    <div className="page-container flex flex-col h-[calc(100vh-60px)]">
      {/* Header */}
      <div className="shrink-0">
        <PageHeader
          title="Schedule"
          subtitle={
            activeView === 'week'
              ? `Week of ${formatDateShort(weekStart)}`
              : `${activeView === 'bays' ? 'Bay schedule' : 'Appointments'} · ${formatDateShort(selectedDate)}`
          }
          breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Schedule' }]}
          actions={
            <div className="flex items-center gap-2">
              {/* View toggle: Appointments / Bays / Week */}
              <div className="flex rounded-md border border-slate-200 overflow-hidden">
                {VIEWS.map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setActiveView(v)}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeView === v ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >{label}</button>
                ))}
              </div>

              {/* Date nav (single-day views) */}
              {isDay && (
                <div className="flex items-center gap-1">
                  <button onClick={prevDay} className="p-1.5 rounded-md border border-slate-200 hover:bg-slate-50" title="Previous day">
                    <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  </button>
                  <button onClick={goToday} className="px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50">
                    Today
                  </button>
                  <button onClick={nextDay} className="p-1.5 rounded-md border border-slate-200 hover:bg-slate-50" title="Next day">
                    <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </button>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="ml-1 text-xs border border-slate-200 rounded-md px-2 py-1.5 text-slate-600"
                  />
                </div>
              )}

              {/* Zoom (single-day views) */}
              {isDay && (
                <div className="flex rounded-md border border-slate-200 overflow-hidden">
                  {(['compact', 'standard', 'detailed'] as ZoomLevel[]).map((z) => (
                    <button
                      key={z}
                      onClick={() => setZoomPersist(z)}
                      className={`px-2 py-1.5 text-[10px] font-medium capitalize transition-colors ${
                        zoom === z ? 'bg-slate-700 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
                      }`}
                    >{z}</button>
                  ))}
                </div>
              )}
            </div>
          }
        />

        {/* Stat cards — single-day views */}
        {isDay && stats && (
          <div className="grid grid-cols-4 gap-3 mb-4">
            <StatCard value={stats.appointments} label="Appointments" color="blue" />
            <StatCard value={stats.walkIns} label="Walk-Ins" color="amber" />
            <StatCard value={stats.completed} label="Completed" color="green" />
            <StatCard value={stats.blocked} label="Blocked" color="red" />
          </div>
        )}
      </div>

      {/* Main content area */}
      <div className="flex-1 min-h-0">
        {/* Appointments — dedicated calendar (no overlap; side-by-side columns) */}
        {activeView === 'appointments' && (
          <>
            {dayQuery.isLoading && <LoadingState message="Loading appointments..." />}
            {dayQuery.isError && (
              <div className="card p-6 text-center text-red-600 text-sm">Failed to load the schedule. Please try again.</div>
            )}
            {data && (
              <AppointmentCalendar
                appointments={apptBlocks}
                holds={holdBlocks}
                operatingHours={data.operatingHours}
                date={selectedDate}
                zoom={zoom}
                onAppointmentClick={(id) => setOpenApptId(id)}
                onHoldClick={(id) => setOpenHoldId(id)}
                onEmptySlotClick={(time) => setCreateAtTime(time)}
              />
            )}
          </>
        )}

        {/* Bays — resource/bay timeline (expanded) + queue rail */}
        {activeView === 'bays' && (
          <>
            {dayQuery.isLoading && <LoadingState message="Loading bay schedule..." />}
            {dayQuery.isError && (
              <div className="card p-6 text-center text-red-600 text-sm">Failed to load the bay schedule.</div>
            )}
            {data && (
              <div className="flex h-full gap-0">
                <div className="flex-1 min-w-0">
                  <ResourceTimeline
                    resources={data.resources}
                    events={data.events}
                    operatingHours={data.operatingHours}
                    date={selectedDate}
                    zoom={zoom}
                    onEventClick={handleEventClick}
                  />
                </div>
                <QueueRail
                  queueItems={data.queueItems}
                  readyForPickup={data.readyForPickup}
                  collapsed={railCollapsed}
                  onToggle={() => setRailCollapsed(!railCollapsed)}
                />
              </div>
            )}
          </>
        )}

        {/* Week overview */}
        {activeView === 'week' && (
          <>
            {weekQuery.isLoading && <LoadingState message="Loading week view..." />}
            {weekQuery.isError && (
              <div className="card p-6 text-center text-red-600 text-sm">Failed to load week schedule.</div>
            )}
            {weekQuery.data && (
              <WeekView
                days={weekQuery.data.days}
                onSelectDay={handleWeekDaySelect}
              />
            )}
          </>
        )}
      </div>

      {/* Appointment detail modal */}
      {openApptId && (
        <AppointmentDetailModal
          appointmentId={openApptId}
          onClose={() => setOpenApptId(null)}
          onChanged={onScheduleChanged}
        />
      )}

      {/* "Create at time" popover (empty-slot click on the Appointments calendar) */}
      {createAtTime && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setCreateAtTime(null)}>
          <div className="card w-80 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-900">New at {createAtTime}</h3>
            <p className="mt-1 text-xs text-slate-500">{formatDateShort(selectedDate)}</p>

            <button
              onClick={() => router.push(`/appointments/new?date=${selectedDate}&time=${createAtTime}`)}
              className="btn-primary text-xs w-full mt-4"
            >
              Schedule Appointment (full details)
            </button>

            {/* Quick hold — reserve the slot now with no details */}
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="input-label">Quick hold (no details)</p>
              <div className="flex gap-1.5 mt-1">
                {[30, 60, 90].map((d) => (
                  <button
                    key={d}
                    onClick={() => setHoldDuration(d)}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${holdDuration === d ? 'bg-slate-700 text-white border-slate-700' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                  >
                    {d}m
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={holdLabel}
                onChange={(e) => setHoldLabel(e.target.value)}
                placeholder="Label (optional)"
                className="input-field mt-2 text-xs"
              />
              {createHoldMutation.isError && (
                <p className="mt-1 text-xs text-red-600">{createHoldMutation.error instanceof Error ? createHoldMutation.error.message : 'Failed to create hold'}</p>
              )}
              <button
                onClick={() => createHoldMutation.mutate({
                  scheduledStartAt: new Date(`${selectedDate}T${createAtTime}:00`).toISOString(),
                  durationMinutes: holdDuration,
                  label: holdLabel.trim() || undefined,
                })}
                disabled={createHoldMutation.isPending}
                className="btn-secondary text-xs w-full mt-2"
              >
                {createHoldMutation.isPending ? 'Holding…' : `Quick Hold (${holdDuration}m)`}
              </button>
            </div>

            <button onClick={() => setCreateAtTime(null)} className="btn-secondary text-xs w-full mt-3">Cancel</button>
          </div>
        </div>
      )}

      {/* Hold detail modal (click a HELD block) */}
      {openHoldId && openHold && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setOpenHoldId(null)}>
          <div className="card w-80 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Held slot</h3>
              <span className="badge bg-slate-100 text-slate-500">HELD</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{formatDateShort(selectedDate)} · {fmtClock(openHold.scheduledStartAt)} – {fmtClock(openHold.scheduledEndAt)}</p>
            {openHold.label && <p className="mt-2 text-sm text-slate-700">{openHold.label}</p>}
            {releaseHoldMutation.isError && (
              <p className="mt-2 text-xs text-red-600">{releaseHoldMutation.error instanceof Error ? releaseHoldMutation.error.message : 'Failed to release'}</p>
            )}
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => router.push(`/appointments/new?date=${selectedDate}&time=${toHHMM(openHold.scheduledStartAt)}&holdId=${openHold.id}`)}
                className="btn-primary text-xs"
              >
                Convert to Appointment
              </button>
              <button onClick={() => releaseHoldMutation.mutate(openHold.id)} disabled={releaseHoldMutation.isPending} className="btn-danger text-xs">
                {releaseHoldMutation.isPending ? 'Releasing…' : 'Release Hold'}
              </button>
              <button onClick={() => setOpenHoldId(null)} className="btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
