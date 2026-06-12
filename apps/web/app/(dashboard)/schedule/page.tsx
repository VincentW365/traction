'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { StatCard } from '../../../components/ui/stat-card';
import { LoadingState } from '../../../components/ui/loading-state';
import { ResourceTimeline } from '../../../components/schedule/resource-timeline';
import { QueueRail } from '../../../components/schedule/queue-rail';
import { WeekView } from '../../../components/schedule/week-view';
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

// --- Component ---

export default function SchedulePage() {
  const siteId = useSiteId();
  const router = useRouter();
  const queryClient = useQueryClient();
  const today = new Date().toISOString().split('T')[0];

  const [selectedDate, setSelectedDate] = useState(today);
  const [activeTab, setActiveTab] = useState<'day' | 'week'>('day');
  const [zoom, setZoom] = useState<ZoomLevel>('standard');
  const [railCollapsed, setRailCollapsed] = useState(false);
  // CR-2026-025 — appointment detail modal + "create at time" popover
  const [openApptId, setOpenApptId] = useState<string | null>(null);
  const [createAtTime, setCreateAtTime] = useState<string | null>(null);

  // Session-persist zoom
  const setZoomPersist = useCallback((z: ZoomLevel) => {
    setZoom(z);
    try { sessionStorage.setItem('schedule_zoom', z); } catch {}
  }, []);

  // Day schedule query
  const dayQuery = useQuery<ScheduleDayResponse>({
    queryKey: ['schedule-day', siteId, selectedDate],
    queryFn: () => api.get(`/schedule/day?siteId=${siteId}&date=${selectedDate}`),
    refetchInterval: activeTab === 'day' ? 10000 : false,
    enabled: activeTab === 'day',
  });

  // Week schedule query
  const weekStart = getMonday(selectedDate);
  const weekQuery = useQuery<ScheduleWeekResponse>({
    queryKey: ['schedule-week', siteId, weekStart],
    queryFn: () => api.get(`/schedule/week?siteId=${siteId}&weekStart=${weekStart}`),
    enabled: activeTab === 'week',
  });

  // Appointments for the day (not bay-bound) → rendered on the timeline's Appointments lane.
  const apptListQuery = useQuery<Array<{
    id: string; scheduledStartAt: string; scheduledEndAt: string | null; status: string;
    customer: { firstName: string; lastName: string };
  }>>({
    queryKey: ['schedule-appointments', siteId, selectedDate],
    queryFn: () => api.get(`/appointments?siteId=${siteId}&date=${selectedDate}`),
    enabled: activeTab === 'day' && !!siteId,
    refetchInterval: activeTab === 'day' ? 10000 : false,
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

  const onScheduleChanged = () => {
    queryClient.invalidateQueries({ queryKey: ['schedule-day'] });
    queryClient.invalidateQueries({ queryKey: ['schedule-appointments'] });
  };

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
      // Navigate to ticket detail — find the event id which encodes the source
      router.push(`/queue/${event.id.replace(/^(res-|occ-|done-)/, '')}`);
    }
  }

  function handleWeekDaySelect(date: string) {
    setSelectedDate(date);
    setActiveTab('day');
  }

  const data = dayQuery.data;
  const stats = data?.stats;

  return (
    <div className="page-container flex flex-col h-[calc(100vh-60px)]">
      {/* Header */}
      <div className="shrink-0">
        <PageHeader
          title="Schedule"
          subtitle={activeTab === 'day' ? formatDateShort(selectedDate) : `Week of ${formatDateShort(weekStart)}`}
          breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Schedule' }]}
          actions={
            <div className="flex items-center gap-2">
              {/* Tab toggle */}
              <div className="flex rounded-md border border-slate-200 overflow-hidden">
                <button
                  onClick={() => setActiveTab('day')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeTab === 'day' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >Day</button>
                <button
                  onClick={() => setActiveTab('week')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeTab === 'week' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >Week</button>
              </div>

              {/* Date nav */}
              {activeTab === 'day' && (
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

              {/* Zoom (day view only) */}
              {activeTab === 'day' && (
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

        {/* Stat cards — day view only */}
        {activeTab === 'day' && stats && (
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
        {activeTab === 'day' && (
          <>
            {dayQuery.isLoading && <LoadingState message="Loading schedule..." />}
            {dayQuery.isError && (
              <div className="card p-6 text-center text-red-600 text-sm">
                Failed to load schedule. Please try again.
              </div>
            )}
            {data && (
              <div className="flex h-full gap-0">
                {/* Timeline */}
                <div className="flex-1 min-w-0">
                  <ResourceTimeline
                    resources={data.resources}
                    events={data.events}
                    operatingHours={data.operatingHours}
                    date={selectedDate}
                    zoom={zoom}
                    onEventClick={handleEventClick}
                    appointments={apptBlocks}
                    onAppointmentClick={(id) => setOpenApptId(id)}
                    onEmptySlotClick={(time) => setCreateAtTime(time)}
                  />
                </div>

                {/* Queue rail */}
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

        {activeTab === 'week' && (
          <>
            {weekQuery.isLoading && <LoadingState message="Loading week view..." />}
            {weekQuery.isError && (
              <div className="card p-6 text-center text-red-600 text-sm">
                Failed to load week schedule.
              </div>
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

      {/* Appointment detail modal (from the Appointments lane) */}
      {openApptId && (
        <AppointmentDetailModal
          appointmentId={openApptId}
          onClose={() => setOpenApptId(null)}
          onChanged={onScheduleChanged}
        />
      )}

      {/* "Create at time" popover (empty-slot click on the Appointments lane) */}
      {createAtTime && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setCreateAtTime(null)}>
          <div className="card w-80 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-900">New appointment</h3>
            <p className="mt-1 text-xs text-slate-500">{formatDateShort(selectedDate)} at {createAtTime}</p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => router.push(`/appointments/new?date=${selectedDate}&time=${createAtTime}`)}
                className="btn-primary text-xs"
              >
                Schedule Appointment
              </button>
              <button onClick={() => setCreateAtTime(null)} className="btn-secondary text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
