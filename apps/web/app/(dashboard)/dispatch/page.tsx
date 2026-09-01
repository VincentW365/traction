'use client';

import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { useAuth } from '../../../hooks/use-auth';
import { PickupNotificationPanel } from '../../../components/pickup-notification-panel';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { KpiStrip, type LiveKpi } from '../../../components/kpi-strip';
import { PAUSE_REASONS } from '../../../lib/service-order-actions';

/* ---------- Read-model types (mirror GET /resources/overview, CR-2026-080) ---------- */

interface CurrentJob {
  serviceVisitId: string;
  serviceOrderId: string | null;
  queueTicketId: string | null;
  ticketNumber: string | null;
  customerName: string;
  vehiclePlate: string;
  vehicleDescription: string;
  technicianId: string | null;
  technicianName: string | null;
  serviceDescription: string | null;
  orderStatus: string | null;
  partsBlocked: boolean;
  startedAt: string;
  expectedEndAt: string | null;
  promisedCompletionAt: string | null;
  elapsedMinutes: number | null;
  aging: boolean;
}

interface ResourceItem {
  resourceId: string;
  code: string;
  name: string;
  resourceCategory: string;
  liftType: string | null;
  hasAlignment: boolean;
  hasDiagnostics: boolean;
  isOperational: boolean;
  operationalReason: string | null;
  status: string;
  currentJob: CurrentJob | null;
  nextReservation: {
    appointmentId: string;
    customerName: string;
    reservedFrom: string;
    reservedUntil: string;
  } | null;
}

interface TechLoad {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  skills: string[];
  openAssignments: number;
  // CR-2026-100 — the workload breakdown: a technician with two jobs waiting on
  // parts is far more available than one deep in a major active job.
  activeJobs: number;
  heldJobs: number;
  jobs: Array<{
    serviceOrderId: string;
    orderStatus: string;
    held: boolean;
    ticketNumber: string | null;
    vehiclePlate: string | null;
    elapsedMinutes: number | null;
  }>;
  state: 'ABSENT' | 'BUSY' | 'ASSIGNED' | 'IDLE';
  shiftStatus: string;
  shift: { start: string; end: string } | null;
  currentJob: {
    serviceOrderId: string;
    orderStatus: string;
    ticketNumber: string | null;
    vehiclePlate: string | null;
    startedAt: string;
    elapsedMinutes: number | null;
  } | null;
}

// CR-2026-100 — a technician pause request awaiting acknowledgement.
interface PauseApprovalItem {
  pauseId: string;
  serviceOrderId: string;
  orderStatus: string;
  serviceVisitId: string;
  queueTicketId: string | null;
  ticketNumber: string | null;
  customerName: string;
  vehiclePlate: string;
  serviceDescription: string | null;
  technicianName: string | null;
  reasonCode: string;
  notes: string | null;
  requestedAt: string;
  enteredOnBehalf: boolean;
  waitingMinutes: number | null;
}

interface NeedsDispatchItem {
  queueTicketId: string;
  serviceVisitId: string;
  ticketNumber: string;
  position: number | null;
  displayStatus: string;
  customerName: string;
  vehiclePlate: string;
  vehicleDescription: string;
  serviceDescription: string;
  partsReadiness: string;
  blockedReason: string | null;
  waitingMinutes: number | null;
}

interface BlockedItem {
  serviceOrderId: string | null;
  queueTicketId: string | null;
  serviceVisitId: string;
  ticketNumber: string | null;
  customerName: string;
  vehiclePlate: string;
  reason: string;
  status: string;
  serviceDescription: string | null;
  blockedMinutes: number | null;
}

interface QcItem {
  serviceOrderId: string;
  serviceVisitId: string;
  queueTicketId: string | null;
  ticketNumber: string | null;
  customerName: string;
  vehiclePlate: string;
  waitingMinutes: number | null;
}

interface OverdueItem {
  serviceOrderId: string;
  serviceVisitId: string;
  queueTicketId: string | null;
  ticketNumber: string | null;
  customerName: string;
  vehiclePlate: string;
  orderStatus: string;
  elapsedMinutes: number | null;
}

interface DispatchOverview {
  siteId: string;
  generatedAt: string;
  summary: {
    resourcesTotal: number;
    available: number;
    occupied: number;
    reserved: number;
    down: number;
    techniciansActive: number;
    techniciansBusy: number;
    techniciansIdle: number;
    techniciansAbsent: number;
    needsDispatch: number;
    blocked: number;
    readyForQc: number;
    overdue: number;
    pauseApprovals: number;
  };
  resources: ResourceItem[];
  technicianLoad: TechLoad[];
  needsDispatch: NeedsDispatchItem[];
  blocked: BlockedItem[];
  readyForQc: QcItem[];
  overdue: OverdueItem[];
  pauseApprovals: PauseApprovalItem[];
}

/**
 * CR-2026-103 — the live KPI position for one in-progress job.
 *
 * `technicianCount` comes from the labour measures rather than the live KPI, which
 * measures a single job clock and cannot see that two people were on it. Without it a
 * shared or reassigned job would be rated as though one technician had done all of it.
 */
interface JobKpi {
  kpi: LiveKpi;
  technicianCount: number;
}

/* ---------- Helpers ---------- */

function fmtMins(m: number | null | undefined): string {
  if (m == null) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function partsLabel(readiness: string): { label: string; className: string } | null {
  if (readiness === 'REQUIRED_NOT_READY') return { label: 'Parts not ready', className: 'bg-red-100 text-red-700' };
  if (readiness === 'REQUIRED_READY') return { label: 'Parts ready', className: 'bg-emerald-100 text-emerald-700' };
  return null;
}

function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => (f ?? '').toLowerCase().includes(needle));
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    BAY: 'Service Bays',
    OVERFLOW: 'Overflow',
    LIGHT_SLOT: 'Light Task Slots',
    POWER_WASH: 'Power Wash',
    EXTERNAL: 'External',
  };
  return map[cat] ?? cat;
}

/* ---------- Page ---------- */

export default function DispatchBoardPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canToggleOperational = ['ADMIN', 'SERVICE_ADVISOR'].includes(user?.roleCode ?? '');

  const [q, setQ] = useState('');
  const [category, setCategory] = useState('ALL');

  const { data, isLoading, isError } = useQuery<DispatchOverview>({
    queryKey: ['dispatch-overview', siteId],
    queryFn: () => api.get(`/resources/overview?siteId=${siteId}`),
    refetchInterval: 5000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['dispatch-overview'] });

  const callNextMutation = useMutation({
    mutationFn: () => api.post('/queue/call-next', { siteId }),
    onSuccess: invalidate,
  });
  const releaseMutation = useMutation({
    mutationFn: (resourceId: string) => api.post(`/resources/${resourceId}/release`),
    onSuccess: invalidate,
  });
  const setOperationalMutation = useMutation({
    mutationFn: (vars: { resourceId: string; isOperational: boolean; reason?: string }) =>
      api.post(`/resources/${vars.resourceId}/operational-status`, {
        isOperational: vars.isOperational,
        reason: vars.reason,
      }),
    onSuccess: invalidate,
  });

  const readyQuery = useQuery<
    Array<{
      serviceVisitId: string;
      ticketNumber: string;
      customerName: string;
      customerPhone: string;
      customerEmail: string | null;
      vehiclePlate: string;
      vehicleDescription: string;
    }>
  >({
    queryKey: ['ready-for-pickup', siteId],
    queryFn: () => api.get(`/queue/ready-for-pickup?siteId=${siteId}`),
    refetchInterval: 10000,
  });

  const s = data?.summary;

  // CR-2026-103 — live KPI for every job under way, on bays and on technicians alike.
  //
  // These ride the overview poll above instead of starting a timer of their own, so a
  // bay's KPI can never disagree with the elapsed time printed beside it. The figures
  // move by the minute at most, so they are refetched when that poll's clock crosses a
  // minute rather than on every five-second tick.
  const liveJobOrderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of data?.resources ?? []) {
      if (r.status === 'OCCUPIED' && r.currentJob?.serviceOrderId) ids.add(r.currentJob.serviceOrderId);
    }
    for (const t of data?.technicianLoad ?? []) {
      if (t.currentJob?.serviceOrderId) ids.add(t.currentJob.serviceOrderId);
    }
    return Array.from(ids).sort();
  }, [data?.resources, data?.technicianLoad]);

  const overviewMinute = data?.generatedAt
    ? Math.floor(new Date(data.generatedAt).getTime() / 60_000)
    : null;

  useEffect(() => {
    if (overviewMinute == null) return;
    queryClient.invalidateQueries({ queryKey: ['dispatch-kpi'] });
  }, [overviewMinute, queryClient]);

  const kpiResults = useQueries({
    queries: liveJobOrderIds.map((orderId) => ({
      queryKey: ['dispatch-kpi', orderId],
      queryFn: async (): Promise<JobKpi> => {
        const [kpi, labour] = await Promise.all([
          api.get<LiveKpi>(`/kpi/orders/${orderId}/live`),
          api.get<{ technicianCount: number }>(`/kpi/orders/${orderId}/labour`),
        ]);
        return { kpi, technicianCount: labour.technicianCount };
      },
      staleTime: 60_000,
    })),
  });

  // A failed fetch leaves the job with no strip at all: an unknown technician count
  // cannot rule out shared work, and a rating that might misattribute is worse than none.
  const kpiByOrder = new Map<string, JobKpi>();
  liveJobOrderIds.forEach((orderId, i) => {
    const result = kpiResults[i]?.data;
    if (result) kpiByOrder.set(orderId, result);
  });

  const categories = useMemo(() => {
    const set = new Set((data?.resources ?? []).map((r) => r.resourceCategory));
    return Array.from(set);
  }, [data?.resources]);

  // --- filtered slices ---
  const resources = (data?.resources ?? []).filter(
    (r) =>
      (category === 'ALL' || r.resourceCategory === category) &&
      matches(q, r.code, r.name, r.currentJob?.ticketNumber, r.currentJob?.customerName, r.currentJob?.vehiclePlate, r.currentJob?.technicianName),
  );
  const needsDispatch = (data?.needsDispatch ?? []).filter((n) =>
    matches(q, n.ticketNumber, n.customerName, n.vehiclePlate, n.serviceDescription),
  );
  const technicianLoad = (data?.technicianLoad ?? []).filter((t) =>
    matches(q, t.employeeCode, t.fullName, t.currentJob?.ticketNumber, t.currentJob?.vehiclePlate),
  );
  const blocked = (data?.blocked ?? []).filter((b) => matches(q, b.ticketNumber, b.customerName, b.vehiclePlate, b.reason));
  const readyForQc = (data?.readyForQc ?? []).filter((r) => matches(q, r.ticketNumber, r.customerName, r.vehiclePlate));
  const overdue = (data?.overdue ?? []).filter((o) => matches(q, o.ticketNumber, o.customerName, o.vehiclePlate));

  return (
    <div className="page-container">
      <PageHeader
        title="Dispatch Board"
        subtitle="Live resource control — technicians, bays, blocked & QC work"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Dispatch Board' }]}
        actions={
          <button
            onClick={() => callNextMutation.mutate()}
            disabled={callNextMutation.isPending}
            className="btn-primary text-sm px-4 py-2 disabled:opacity-50"
          >
            {callNextMutation.isPending ? 'Dispatching…' : 'Call Next'}
          </button>
        }
      />

      {callNextMutation.isSuccess && (
        <div className="card border-l-4 border-l-emerald-500 bg-emerald-50/50 p-3 mb-5">
          <p className="text-sm text-emerald-700 font-medium">{(callNextMutation.data as any)?.message}</p>
        </div>
      )}

      {/* Summary chips */}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 mb-5">
          <StatChip label="Needs Dispatch" value={s.needsDispatch} tone="blue" />
          <StatChip label="In Service" value={s.occupied} tone="amber" />
          <StatChip label="Blocked" value={s.blocked} tone="red" />
          <StatChip label="Pause Approvals" value={s.pauseApprovals ?? 0} tone="amber" />
          <StatChip label="Ready for QC" value={s.readyForQc} tone="violet" />
          <StatChip label="Overdue" value={s.overdue} tone="rose" />
          <StatChip label="Techs Idle / Busy" value={`${s.techniciansIdle} / ${s.techniciansBusy}`} tone="slate" />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search ticket, customer, plate, tech…"
          className="input-field text-sm max-w-xs"
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field text-sm w-auto">
          <option value="ALL">All resources</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
        {q && (
          <button onClick={() => setQ('')} className="text-xs text-slate-400 hover:text-slate-600">
            Clear
          </button>
        )}
      </div>

      <PickupNotificationPanel readyVisits={readyQuery.data ?? []} />

      {isLoading && <LoadingState message="Loading dispatch board…" />}
      {isError && (
        <div className="card border-red-200 bg-red-50 p-5 text-center">
          <p className="text-sm text-red-700 font-medium">Failed to load dispatch board. Retrying…</p>
        </div>
      )}

      {data && (
        <div className="space-y-5">
          {/* CR-2026-100 §9 — pause requests awaiting acknowledgement, never buried. */}
          {(data.pauseApprovals ?? []).length > 0 && (
            <Panel
              title="Pause Approval Required"
              count={(data.pauseApprovals ?? []).length}
              accent="bg-amber-500"
              empty="No pause requests waiting"
            >
              <div className="space-y-2">
                {(data.pauseApprovals ?? []).map((p) => (
                  <PauseApprovalRow key={p.pauseId} item={p} onDone={invalidate} />
                ))}
              </div>
            </Panel>
          )}

          {/* Row: Needs Dispatch + Technician Load */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <Panel title="Needs Dispatch" count={needsDispatch.length} accent="bg-blue-500" empty="Nothing waiting for a bay">
              <div className="space-y-2">
                {needsDispatch.map((n) => (
                  <NeedsDispatchRow key={n.queueTicketId} item={n} />
                ))}
              </div>
            </Panel>

            <Panel title="Technician Load" count={technicianLoad.length} accent="bg-slate-500" empty="No active technicians">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {technicianLoad.map((t) => (
                  <TechCard
                    key={t.technicianId}
                    tech={t}
                    jobKpi={t.currentJob ? kpiByOrder.get(t.currentJob.serviceOrderId) : undefined}
                  />
                ))}
              </div>
            </Panel>
          </div>

          {/* Bay / Resource view */}
          <Panel title="Bay & Resource View" count={resources.length} accent="bg-amber-500" empty="No resources match">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {resources.map((r) => (
                <ResourceCard
                  key={r.resourceId}
                  resource={r}
                  jobKpi={r.currentJob?.serviceOrderId ? kpiByOrder.get(r.currentJob.serviceOrderId) : undefined}
                  canToggleOperational={canToggleOperational}
                  busy={setOperationalMutation.isPending}
                  onRelease={() => releaseMutation.mutate(r.resourceId)}
                  onSetOperational={(isOperational, reason) =>
                    setOperationalMutation.mutate({ resourceId: r.resourceId, isOperational, reason })
                  }
                />
              ))}
            </div>
          </Panel>

          {/* Row: Blocked + Ready/QC + Overdue */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <Panel title="Blocked" count={blocked.length} accent="bg-red-500" empty="Nothing blocked">
              <div className="space-y-2">
                {blocked.map((b, i) => (
                  <AwarenessRow
                    key={(b.serviceOrderId ?? b.queueTicketId ?? b.serviceVisitId) + i}
                    ticketNumber={b.ticketNumber}
                    customerName={b.customerName}
                    vehiclePlate={b.vehiclePlate}
                    badge={{ text: b.reason, className: 'bg-red-100 text-red-700' }}
                    meta={b.serviceDescription ?? undefined}
                    since={b.blockedMinutes}
                    href={b.queueTicketId ? `/queue/${b.queueTicketId}` : undefined}
                  />
                ))}
              </div>
            </Panel>

            <Panel title="Ready for QC" count={readyForQc.length} accent="bg-violet-500" empty="Nothing awaiting QC">
              <div className="space-y-2">
                {readyForQc.map((r) => (
                  <AwarenessRow
                    key={r.serviceOrderId}
                    ticketNumber={r.ticketNumber}
                    customerName={r.customerName}
                    vehiclePlate={r.vehiclePlate}
                    badge={{ text: 'Awaiting QC', className: 'bg-violet-100 text-violet-700' }}
                    since={r.waitingMinutes}
                    href={r.queueTicketId ? `/queue/${r.queueTicketId}` : undefined}
                  />
                ))}
              </div>
            </Panel>

            <Panel title="Overdue" count={overdue.length} accent="bg-rose-500" empty="Nothing overdue">
              <div className="space-y-2">
                {overdue.map((o) => (
                  <AwarenessRow
                    key={o.serviceOrderId}
                    ticketNumber={o.ticketNumber}
                    customerName={o.customerName}
                    vehiclePlate={o.vehiclePlate}
                    badge={{ text: `${fmtMins(o.elapsedMinutes)} elapsed`, className: 'bg-rose-100 text-rose-700' }}
                    href={o.queueTicketId ? `/queue/${o.queueTicketId}` : undefined}
                  />
                ))}
              </div>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Sub-components ---------- */

function StatChip({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  const tones: Record<string, string> = {
    blue: 'border-l-blue-500',
    amber: 'border-l-amber-500',
    red: 'border-l-red-500',
    violet: 'border-l-violet-500',
    rose: 'border-l-rose-500',
    slate: 'border-l-slate-400',
  };
  return (
    <div className={`card border-l-4 ${tones[tone] ?? 'border-l-slate-400'} px-3 py-2`}>
      <div className="text-lg font-bold text-slate-900 tabular-nums">{value}</div>
      <div className="text-[11px] text-slate-500 uppercase tracking-wide">{label}</div>
    </div>
  );
}

function Panel({
  title,
  count,
  accent,
  empty,
  children,
}: {
  title: string;
  count: number;
  accent: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${accent}`} />
          <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
          <span className="text-xs text-slate-400">({count})</span>
        </div>
      </div>
      <div className="p-3">
        {count === 0 ? <p className="text-xs text-slate-400 text-center py-6">{empty}</p> : children}
      </div>
    </section>
  );
}

function NeedsDispatchRow({ item }: { item: NeedsDispatchItem }) {
  const parts = partsLabel(item.partsReadiness);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-white p-2.5">
      <div className="text-center shrink-0 w-10">
        <div className="text-lg font-bold text-slate-800 tabular-nums">{item.position ?? '–'}</div>
        <div className="text-[10px] text-slate-400">pos</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold text-blue-700">{item.ticketNumber}</span>
          <span className="text-sm font-medium text-slate-800 truncate">{item.customerName}</span>
        </div>
        <div className="text-xs text-slate-500 truncate">{item.serviceDescription}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] text-slate-400">{item.vehiclePlate}</span>
          <span className="text-[11px] text-slate-400">· waiting {fmtMins(item.waitingMinutes)}</span>
          {parts && <span className={`text-[10px] px-1.5 py-0.5 rounded ${parts.className}`}>{parts.label}</span>}
        </div>
      </div>
      <Link href={`/queue/${item.queueTicketId}`} className="btn-secondary text-xs px-3 py-1 shrink-0">
        Assign
      </Link>
    </div>
  );
}

function TechCard({ tech, jobKpi }: { tech: TechLoad; jobKpi?: JobKpi }) {
  const stateStyle: Record<string, string> = {
    BUSY: 'bg-amber-100 text-amber-700',
    ASSIGNED: 'bg-blue-100 text-blue-700',
    IDLE: 'bg-emerald-100 text-emerald-700',
    ABSENT: 'bg-slate-200 text-slate-500',
  };
  const heldJobs = (tech.jobs ?? []).filter((j) => j.held);
  return (
    <div className="rounded-lg border border-slate-100 bg-white p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-800 truncate">{tech.fullName}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${stateStyle[tech.state]}`}>{tech.state}</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="font-mono text-[11px] text-slate-400">{tech.employeeCode}</span>
        {/* CR-2026-100 — the workload breakdown, not a single "busy" flag: a
            technician with two jobs on hold is far more available than one deep
            in a major active job. */}
        <span className="text-[11px] text-slate-400">
          · {tech.activeJobs ?? 0} active{(tech.heldJobs ?? 0) > 0 ? ` · ${tech.heldJobs} on hold` : ''}
        </span>
      </div>
      {tech.currentJob ? (
        <>
          <div className="text-[11px] text-slate-500 mt-1 truncate">
            {tech.currentJob.ticketNumber} · {tech.currentJob.vehiclePlate} · {fmtMins(tech.currentJob.elapsedMinutes)}
          </div>
          {jobKpi && (
            <div className="mt-1.5">
              <KpiStrip kpi={jobKpi.kpi} variant="dense" technicianCount={jobKpi.technicianCount} />
            </div>
          )}
        </>
      ) : (
        <div className="text-[11px] text-slate-300 mt-1">No active job</div>
      )}
      {heldJobs.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {heldJobs.map((j) => (
            <div key={j.serviceOrderId} className="text-[11px] text-amber-700 truncate">
              ⏸ {j.ticketNumber ?? j.vehiclePlate} · {j.orderStatus === 'WAITING_PARTS' ? 'parts' : j.orderStatus === 'WAITING_CUSTOMER' ? 'customer' : 'paused'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * CR-2026-100 §5/§9 — one pending pause request: who reported the stop, why,
 * since when — with Approve / Reject right here and a link into the job.
 * Approval never moves the clock; the interval has been running from the
 * technician's own timestamp all along. Rejection requires a reason and
 * resumes the work; the original request is kept.
 */
function PauseApprovalRow({ item, onDone }: { item: PauseApprovalItem; onDone: () => void }) {
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const approve = useMutation({
    mutationFn: () => api.post(`/service-orders/${item.serviceOrderId}/pauses/${item.pauseId}/approve`, {}),
    onSuccess: onDone,
  });
  const reject = useMutation({
    mutationFn: () =>
      api.post(`/service-orders/${item.serviceOrderId}/pauses/${item.pauseId}/reject`, { reason: rejectReason.trim() }),
    onSuccess: () => { setShowReject(false); setRejectReason(''); onDone(); },
  });
  const reasonLabel = PAUSE_REASONS.find((r) => r.value === item.reasonCode)?.label ?? item.reasonCode;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono text-xs font-bold text-blue-700">{item.ticketNumber ?? '—'}</span>
          <span className="text-sm font-medium text-slate-800 ml-2">{item.customerName}</span>
          <span className="text-[11px] text-slate-400 ml-2">{item.vehiclePlate}</span>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 shrink-0">
          waiting {item.waitingMinutes ?? 0} min
        </span>
      </div>
      <p className="text-xs text-slate-600">
        <span className="font-semibold">{reasonLabel}</span>
        {item.technicianName ? <> · {item.technicianName}</> : null}
        {' · requested '}
        {new Date(item.requestedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        {item.enteredOnBehalf ? ' · entered on the technician’s behalf' : ''}
      </p>
      {item.notes && <p className="text-xs text-slate-500 italic">“{item.notes}”</p>}
      {showReject ? (
        <div className="space-y-1.5">
          <input
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Why is this rejected? (required — the technician sees it)"
            className="input-field text-xs"
          />
          {reject.isError && (
            <p className="text-[11px] text-red-600">{reject.error instanceof Error ? reject.error.message : 'Failed'}</p>
          )}
          <div className="flex gap-1.5">
            <button
              onClick={() => reject.mutate()}
              disabled={reject.isPending || !rejectReason.trim()}
              className="btn-danger text-xs px-3 py-1"
            >
              {reject.isPending ? 'Rejecting…' : 'Confirm Reject'}
            </button>
            <button onClick={() => setShowReject(false)} className="btn-secondary text-xs px-3 py-1">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button onClick={() => approve.mutate()} disabled={approve.isPending} className="btn-success text-xs px-3 py-1">
            {approve.isPending ? 'Approving…' : 'Approve'}
          </button>
          <button onClick={() => setShowReject(true)} className="btn-secondary text-xs px-3 py-1">Reject</button>
          {item.queueTicketId && (
            <Link href={`/queue/${item.queueTicketId}`} className="text-xs text-blue-700 hover:underline ml-auto">
              Open job →
            </Link>
          )}
          {approve.isError && (
            <p className="text-[11px] text-red-600">{approve.error instanceof Error ? approve.error.message : 'Failed'}</p>
          )}
        </div>
      )}
    </div>
  );
}

function AwarenessRow({
  ticketNumber,
  customerName,
  vehiclePlate,
  badge,
  meta,
  since,
  href,
}: {
  ticketNumber: string | null;
  customerName: string;
  vehiclePlate: string;
  badge: { text: string; className: string };
  meta?: string;
  since?: number | null;
  href?: string;
}) {
  const body = (
    <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-white p-2.5 hover:border-slate-200">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {ticketNumber && <span className="font-mono text-xs font-bold text-slate-600">{ticketNumber}</span>}
          <span className="text-sm font-medium text-slate-800 truncate">{customerName}</span>
        </div>
        <div className="text-[11px] text-slate-400 truncate">
          {vehiclePlate}
          {meta && ` · ${meta}`}
          {since != null && ` · ${fmtMins(since)}`}
        </div>
      </div>
      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${badge.className}`}>{badge.text}</span>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/* ---------- Enriched resource card ---------- */

function ResourceCard({
  resource: r,
  jobKpi,
  canToggleOperational,
  busy,
  onRelease,
  onSetOperational,
}: {
  resource: ResourceItem;
  jobKpi?: JobKpi;
  canToggleOperational: boolean;
  busy: boolean;
  onRelease: () => void;
  onSetOperational: (isOperational: boolean, reason?: string) => void;
}) {
  const [showDownForm, setShowDownForm] = useState(false);
  const [downReason, setDownReason] = useState('');

  const border =
    !r.isOperational
      ? 'border-l-red-500'
      : r.status === 'OCCUPIED'
        ? r.currentJob?.aging
          ? 'border-l-rose-600'
          : 'border-l-amber-500'
        : r.status === 'RESERVED'
          ? 'border-l-blue-500'
          : 'border-l-emerald-500';

  const dot =
    r.status === 'AVAILABLE'
      ? { color: 'bg-emerald-500', label: 'Available' }
      : r.status === 'OCCUPIED'
        ? { color: 'bg-amber-500', label: 'Occupied' }
        : r.status === 'RESERVED'
          ? { color: 'bg-blue-500', label: 'Reserved' }
          : { color: 'bg-slate-400', label: r.status };

  return (
    <div className={`card border-l-4 ${border} overflow-hidden`}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-sm font-bold text-slate-900">{r.code}</span>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <span className={`w-2 h-2 rounded-full ${dot.color}`} />
            {dot.label}
          </span>
        </div>
        <p className="text-xs text-slate-400 mb-2">{r.name}</p>

        {!r.isOperational && (
          <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5">
            <p className="text-[11px] font-semibold text-red-700">● Down for maintenance</p>
            {r.operationalReason && <p className="text-[10px] text-red-600 mt-0.5">{r.operationalReason}</p>}
          </div>
        )}

        {r.status === 'OCCUPIED' && r.currentJob && (
          <div className="border-t border-slate-100 pt-3 mt-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs font-semibold text-slate-700">{r.currentJob.ticketNumber ?? '—'}</span>
              <span className={`font-mono text-xs font-medium ${r.currentJob.aging ? 'text-rose-600' : 'text-amber-600'}`}>
                {fmtMins(r.currentJob.elapsedMinutes)}
                {r.currentJob.aging && ' ⚠'}
              </span>
            </div>
            <p className="text-xs text-slate-600 truncate">{r.currentJob.customerName}</p>
            {r.currentJob.serviceDescription && (
              <p className="text-xs text-slate-500 truncate">{r.currentJob.serviceDescription}</p>
            )}
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-slate-400">{r.currentJob.vehiclePlate}</span>
              {r.currentJob.technicianName && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                  {r.currentJob.technicianName}
                </span>
              )}
              {r.currentJob.partsBlocked && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">Parts not ready</span>
              )}
            </div>
            {jobKpi && (
              <KpiStrip kpi={jobKpi.kpi} variant="dense" technicianCount={jobKpi.technicianCount} />
            )}
            <div className="flex gap-2 pt-1">
              {r.currentJob.queueTicketId && (
                <Link
                  href={`/queue/${r.currentJob.queueTicketId}`}
                  className="btn-secondary text-xs px-3 py-1 flex-1 text-center"
                >
                  Open
                </Link>
              )}
              <button onClick={onRelease} className="btn-secondary text-xs px-3 py-1 flex-1">
                Release Bay
              </button>
            </div>
          </div>
        )}

        {r.status === 'RESERVED' && r.nextReservation && (
          <div className="border-t border-slate-100 pt-3 mt-2 space-y-1">
            <p className="text-xs text-slate-600 font-medium truncate">Reserved: {r.nextReservation.customerName}</p>
            <p className="font-mono text-xs text-slate-400">
              {new Date(r.nextReservation.reservedFrom).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {' – '}
              {new Date(r.nextReservation.reservedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        )}

        {r.isOperational && r.status === 'AVAILABLE' && (
          <div className="border-t border-slate-100 pt-3 mt-2">
            <p className="text-xs text-emerald-600 font-medium text-center">Ready for assignment</p>
          </div>
        )}

        {canToggleOperational && (
          <div className="border-t border-slate-100 pt-2 mt-2">
            {!r.isOperational ? (
              <button onClick={() => onSetOperational(true)} disabled={busy} className="btn-secondary text-xs px-3 py-1 w-full">
                {busy ? 'Saving…' : 'Back up'}
              </button>
            ) : showDownForm ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={downReason}
                  onChange={(e) => setDownReason(e.target.value)}
                  placeholder="Reason (e.g. broken lift)"
                  className="input-field text-xs"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      onSetOperational(false, downReason.trim() || undefined);
                      setShowDownForm(false);
                      setDownReason('');
                    }}
                    disabled={busy}
                    className="btn-danger text-xs px-3 py-1 flex-1"
                  >
                    {busy ? 'Saving…' : 'Confirm down'}
                  </button>
                  <button onClick={() => { setShowDownForm(false); setDownReason(''); }} className="btn-secondary text-xs px-3 py-1">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowDownForm(true)} className="text-[11px] text-slate-400 hover:text-red-600 font-medium">
                Mark down for maintenance
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
