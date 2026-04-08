'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PickupNotificationPanel } from '../../../components/pickup-notification-panel';
import { PageHeader } from '../../../components/ui/page-header';
import { EmptyState } from '../../../components/ui/empty-state';
import { LoadingState } from '../../../components/ui/loading-state';
import { StatCard } from '../../../components/ui/stat-card';

interface ResourceBoard {
  siteId: string;
  generatedAt: string;
  resources: ResourceItem[];
}

interface ResourceItem {
  resourceId: string;
  code: string;
  name: string;
  resourceCategory: string;
  maxVehicleWeight: string | null;
  liftType: string | null;
  hasAlignment: boolean;
  hasDiagnostics: boolean;
  requiresMechanic: boolean;
  status: string;
  currentJob: {
    serviceVisitId: string;
    ticketNumber: string | null;
    customerName: string;
    vehiclePlate: string;
    vehicleDescription: string;
    startedAt: string;
    expectedEndAt: string | null;
  } | null;
  nextReservation: {
    appointmentId: string;
    customerName: string;
    reservedFrom: string;
    reservedUntil: string;
  } | null;
}

/* ---------- Helpers ---------- */

function elapsedMinutes(startedAt: string): number {
  return Math.round((Date.now() - new Date(startedAt).getTime()) / 60000);
}

function borderColor(status: string): string {
  if (status === 'AVAILABLE') return 'border-l-emerald-500';
  if (status === 'OCCUPIED') return 'border-l-amber-500';
  if (status === 'RESERVED') return 'border-l-blue-500';
  return 'border-l-slate-300';
}

function statusDot(status: string): { color: string; label: string } {
  if (status === 'AVAILABLE') return { color: 'bg-emerald-500', label: 'Available' };
  if (status === 'OCCUPIED') return { color: 'bg-amber-500', label: 'Occupied' };
  if (status === 'RESERVED') return { color: 'bg-blue-500', label: 'Reserved' };
  return { color: 'bg-slate-400', label: status };
}

function categoryLabel(cat: string): string {
  if (cat === 'BAY') return 'Service Bays';
  if (cat === 'OVERFLOW') return 'Overflow Area';
  if (cat === 'LIGHT_SLOT') return 'Light Task Slots';
  return cat;
}

function categoryIcon(cat: string): React.ReactNode {
  if (cat === 'BAY') {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    );
  }
  if (cat === 'OVERFLOW') {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
}

/* ---------- Component ---------- */

export default function DispatchBoardPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<ResourceBoard>({
    queryKey: ['dispatch-board', siteId],
    queryFn: () => api.get(`/resources/board?siteId=${siteId}`),
    refetchInterval: 5000,
  });

  const callNextMutation = useMutation({
    mutationFn: () => api.post('/queue/call-next', { siteId: siteId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dispatch-board'] }),
  });

  const releaseMutation = useMutation({
    mutationFn: (resourceId: string) => api.post(`/resources/${resourceId}/release`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dispatch-board'] }),
  });

  const readyQuery = useQuery<Array<{
    serviceVisitId: string; ticketNumber: string; customerName: string;
    customerPhone: string; customerEmail: string | null;
    vehiclePlate: string; vehicleDescription: string;
  }>>({
    queryKey: ['ready-for-pickup', siteId],
    queryFn: () => api.get(`/queue/ready-for-pickup?siteId=${siteId}`),
    refetchInterval: 10000,
  });

  const resources = data?.resources ?? [];
  const availableCount = resources.filter((r) => r.status === 'AVAILABLE').length;
  const occupiedCount = resources.filter((r) => r.status === 'OCCUPIED').length;
  const reservedCount = resources.filter((r) => r.status === 'RESERVED').length;

  const bays = resources.filter((r) => r.resourceCategory === 'BAY');
  const overflow = resources.filter((r) => r.resourceCategory === 'OVERFLOW');
  const lightSlots = resources.filter((r) => r.resourceCategory === 'LIGHT_SLOT');

  const sections = [
    { key: 'BAY', items: bays },
    { key: 'OVERFLOW', items: overflow },
    { key: 'LIGHT_SLOT', items: lightSlots },
  ].filter((s) => s.items.length > 0);

  return (
    <div className="page-container">
      <PageHeader
        title="Dispatch Board"
        subtitle="Resource allocation and bay management"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Dispatch Board' },
        ]}
        actions={
          <button
            onClick={() => callNextMutation.mutate()}
            disabled={callNextMutation.isPending}
            className="btn-primary text-sm px-4 py-2 disabled:opacity-50"
          >
            {callNextMutation.isPending ? 'Dispatching...' : 'Call Next'}
          </button>
        }
      />

      {/* Call-next success toast */}
      {callNextMutation.isSuccess && (
        <div className="card border-l-4 border-l-emerald-500 bg-emerald-50/50 p-3 mb-5">
          <p className="text-sm text-emerald-700 font-medium">
            {(callNextMutation.data as any)?.message}
          </p>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <StatCard value={availableCount} label="Available" color="green" />
        <StatCard value={occupiedCount} label="Occupied" color="amber" />
        <StatCard value={reservedCount} label="Reserved" color="blue" />
      </div>

      {/* Pickup notification panel */}
      <PickupNotificationPanel readyVisits={readyQuery.data ?? []} />

      {/* Loading */}
      {isLoading && <LoadingState message="Loading dispatch board..." />}

      {/* Error */}
      {isError && (
        <div className="card border-red-200 bg-red-50 p-5 text-center">
          <p className="text-sm text-red-700 font-medium">Failed to load dispatch board. Retrying...</p>
        </div>
      )}

      {/* Empty */}
      {data && resources.length === 0 && (
        <EmptyState
          title="No resources configured"
          description="Add service bays and resources to get started."
          icon={
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          }
        />
      )}

      {/* Resource sections */}
      {sections.map((section) => (
        <section key={section.key} className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-slate-400">{categoryIcon(section.key)}</div>
            <h2 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              {categoryLabel(section.key)}
            </h2>
            <span className="text-xs text-slate-400">({section.items.length})</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {section.items.map((r) => (
              <ResourceCard
                key={r.resourceId}
                resource={r}
                onRelease={() => releaseMutation.mutate(r.resourceId)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ---------- Resource Card ---------- */

function ResourceCard({ resource: r, onRelease }: { resource: ResourceItem; onRelease: () => void }) {
  const dot = statusDot(r.status);
  const capabilities: string[] = [];
  if (r.liftType) capabilities.push(r.liftType);
  if (r.hasAlignment) capabilities.push('Alignment');
  if (r.hasDiagnostics) capabilities.push('Diagnostics');
  if (r.maxVehicleWeight) capabilities.push(`Max ${r.maxVehicleWeight}`);

  return (
    <div className={`card border-l-4 ${borderColor(r.status)} overflow-hidden`}>
      <div className="p-4">
        {/* Header: code + status */}
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-sm font-bold text-slate-900">{r.code}</span>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <span className={`w-2 h-2 rounded-full ${dot.color}`} />
            {dot.label}
          </span>
        </div>
        <p className="text-xs text-slate-400 mb-2">{r.name}</p>

        {/* Capabilities */}
        {capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {capabilities.map((cap) => (
              <span
                key={cap}
                className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-500 uppercase tracking-wide"
              >
                {cap}
              </span>
            ))}
          </div>
        )}

        {/* Occupied: current job */}
        {r.status === 'OCCUPIED' && r.currentJob && (
          <div className="border-t border-slate-100 pt-3 mt-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs font-semibold text-slate-700">{r.currentJob.ticketNumber}</span>
              <span className="font-mono text-xs text-amber-600 font-medium">
                {elapsedMinutes(r.currentJob.startedAt)} min
              </span>
            </div>
            <p className="text-xs text-slate-600">{r.currentJob.customerName}</p>
            <p className="text-xs text-slate-400">
              {r.currentJob.vehiclePlate} &middot; {r.currentJob.vehicleDescription}
            </p>
            <button
              onClick={onRelease}
              className="btn-secondary text-xs px-3 py-1 mt-2 w-full"
            >
              Release Bay
            </button>
          </div>
        )}

        {/* Reserved: next reservation */}
        {r.status === 'RESERVED' && r.nextReservation && (
          <div className="border-t border-slate-100 pt-3 mt-2 space-y-1">
            <p className="text-xs text-slate-600 font-medium">
              Reserved: {r.nextReservation.customerName}
            </p>
            <p className="font-mono text-xs text-slate-400">
              {new Date(r.nextReservation.reservedFrom).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {' - '}
              {new Date(r.nextReservation.reservedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        )}

        {/* Available */}
        {r.status === 'AVAILABLE' && (
          <div className="border-t border-slate-100 pt-3 mt-2">
            <p className="text-xs text-emerald-600 font-medium text-center">Ready for assignment</p>
          </div>
        )}
      </div>
    </div>
  );
}
