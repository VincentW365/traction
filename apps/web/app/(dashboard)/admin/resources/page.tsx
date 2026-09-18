'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { CapacitySummary } from '../../../../components/resources/capacity-summary';

/**
 * CR-2026-095 — Resources & Bays, the authoritative operational configuration area.
 *
 * "We opened Bay 6" or "the lift is being repaired" is handled here, takes effect
 * immediately in scheduling and dispatch, and requires nobody with a code editor.
 *
 * The screen speaks operations, not database: statuses read "Temporarily
 * Unavailable", not the enum; warnings name the appointments a change would touch;
 * and destructive-looking actions explain what actually happens (retirement keeps
 * every historical record).
 */

interface WorkResource {
  id: string;
  code: string;
  name: string;
  resourceCategory: string;
  liftType: string | null;
  hasAlignment: boolean;
  hasDiagnostics: boolean;
  requiresMechanic: boolean;
  showOnDispatchBoard: boolean;
  supportsSedan: boolean;
  supportsSuv: boolean;
  schedulingEnabled: boolean;
  capacity: number;
  isActive: boolean;
  displayOrder: number;
  notes: string | null;
  /** CR-2026-108 Stage 5B — every row starts UNVERIFIED and counts for nothing. */
  capacityRole?: string;
  /** CR-2026-108 §21 — the kinds of work that can happen here. */
  serviceCapabilities?: Array<{ capability: string }>;
  retiredAt: string | null;
  retireReason: string | null;
  updatedAt: string;
  operationalStatus?: {
    status: string;
    reason: string | null;
    expectedReturnAt: string | null;
  } | null;
  occupancy?: { status: string } | null;
}

interface Overview {
  totalActive: number;
  availableNow: number;
  inUse: number;
  maintenance: number;
  temporarilyUnavailable: number;
  outOfService: number;
  retired: number;
  sedanBays: number;
  suvBays: number;
}

interface Impact {
  occupiedNow: boolean;
  activeAssignments: number;
  futureReservations: number;
  historicalAssignments: number;
  everUsed: boolean;
}

interface HistoryEvent {
  id: string;
  at: string;
  by: string;
  action: string;
  reason: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  BAY: 'Bay',
  OVERFLOW: 'Overflow',
  LIGHT_SLOT: 'Light Slot',
  POWER_WASH: 'Power Wash',
  EXTERNAL: 'External',
};

/**
 * CR-2026-108 §21 — "does this count as an independent vehicle work position?"
 * in shop words. UNVERIFIED and equipment both contribute nothing, and the
 * difference between them is a decision versus the absence of one.
 */
const ROLE_LABEL: Record<string, string> = {
  UNVERIFIED: 'Not confirmed — counts for nothing',
  PRIMARY_SERVICE_POSITION: 'Work position',
  OVERFLOW_SERVICE_POSITION: 'Overflow position',
  SUPPORT_EQUIPMENT: 'Equipment — not a position',
  PLACEHOLDER: 'Planned — not built',
};

const ROLE_BADGE: Record<string, string> = {
  UNVERIFIED: 'bg-amber-50 text-amber-700 border border-amber-200',
  PRIMARY_SERVICE_POSITION: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  OVERFLOW_SERVICE_POSITION: 'bg-teal-50 text-teal-700 border border-teal-200',
  SUPPORT_EQUIPMENT: 'bg-slate-100 text-slate-600 border border-slate-200',
  PLACEHOLDER: 'bg-slate-100 text-slate-500 border border-slate-200',
};

const WORK_LABEL: Record<string, string> = {
  ALIGNMENT: 'Alignment',
  DIAGNOSTIC: 'Diagnostics',
  GENERAL: 'General repair',
  INSPECTION: 'Inspection',
  LUBE: 'Oil & lube',
  TIRE: 'Tires',
  CLEANING: 'Cleaning',
};

const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: 'Available',
  TEMPORARILY_UNAVAILABLE: 'Temporarily Unavailable',
  MAINTENANCE: 'Maintenance',
  OUT_OF_SERVICE: 'Out of Service',
};

const STATUS_BADGE: Record<string, string> = {
  AVAILABLE: 'bg-emerald-50 text-emerald-700',
  TEMPORARILY_UNAVAILABLE: 'bg-amber-50 text-amber-700',
  MAINTENANCE: 'bg-orange-50 text-orange-700',
  OUT_OF_SERVICE: 'bg-red-50 text-red-700',
};

const ACTION_LABEL: Record<string, string> = {
  RESOURCE_CREATE: 'Created',
  RESOURCE_UPDATE: 'Configuration changed',
  RESOURCE_OPERATIONAL_STATUS_CHANGE: 'Status changed',
  RESOURCE_RETIRE: 'Retired',
  RESOURCE_REACTIVATE: 'Returned to service',
  RESOURCE_DELETE: 'Deleted',
  MOBILE_JACK_OVERRIDE: 'Mobile-jack override used',
};

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function vehicleClassLabel(r: WorkResource): string {
  if (r.supportsSedan && r.supportsSuv) return 'Sedan + SUV';
  if (r.supportsSedan) return 'Sedan only';
  if (r.supportsSuv) return 'SUV only';
  return '—';
}

function capabilitySummary(r: WorkResource): string {
  const caps: string[] = [];
  if (r.liftType) caps.push(r.liftType === 'mobile' ? 'Mobile jack' : `${r.liftType} lift`);
  if (r.hasAlignment) caps.push('Alignment');
  if (r.hasDiagnostics) caps.push('Diagnostics');
  return caps.length ? caps.join(' · ') : 'General';
}

/** Shared shape for the add and edit forms. */
interface FormState {
  code: string;
  name: string;
  resourceCategory: string;
  liftType: string;
  hasAlignment: boolean;
  hasDiagnostics: boolean;
  requiresMechanic: boolean;
  showOnDispatchBoard: boolean;
  supportsSedan: boolean;
  supportsSuv: boolean;
  schedulingEnabled: boolean;
  capacity: number;
  displayOrder: number;
  notes: string;
}

const EMPTY_FORM: FormState = {
  code: '',
  name: '',
  resourceCategory: 'BAY',
  liftType: '',
  hasAlignment: false,
  hasDiagnostics: false,
  requiresMechanic: true,
  showOnDispatchBoard: true,
  supportsSedan: true,
  supportsSuv: true,
  schedulingEnabled: true,
  capacity: 1,
  displayOrder: 0,
  notes: '',
};

export default function ResourcesAdminPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();

  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState('');
  const [sortBy, setSortBy] = useState('display');
  const [showRetired, setShowRetired] = useState(false);
  const [search, setSearch] = useState('');

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WorkResource | null>(null);
  const [statusTarget, setStatusTarget] = useState<WorkResource | null>(null);
  const [historyTarget, setHistoryTarget] = useState<WorkResource | null>(null);

  const resQuery = useQuery<WorkResource[]>({
    queryKey: ['resources-admin', siteId],
    queryFn: () => api.get(`/resources?siteId=${siteId}`),
    refetchInterval: 30_000,
  });
  const overviewQuery = useQuery<Overview>({
    queryKey: ['resources-overview', siteId],
    queryFn: () => api.get(`/resources/overview-admin?siteId=${siteId}`),
    refetchInterval: 30_000,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['resources-admin'] });
    queryClient.invalidateQueries({ queryKey: ['resources-overview'] });
    queryClient.invalidateQueries({ queryKey: ['dispatch'] });
  };

  const data = resQuery.data ?? [];
  // Unconfirmed rows are invisible on this screen but are the reason the derived
  // position count is lower than the inventory looks. Surface the number here.
  const unconfirmedCount = data.filter((r) => !r.retiredAt && (r.capacityRole ?? 'UNVERIFIED') === 'UNVERIFIED').length;
  const filtered = data
    .filter((r) => (showRetired ? true : !r.retiredAt))
    .filter((r) => (categoryFilter ? r.resourceCategory === categoryFilter : true))
    .filter((r) => {
      if (!statusFilter) return true;
      if (statusFilter === 'RETIRED') return !!r.retiredAt;
      return !r.retiredAt && (r.operationalStatus?.status ?? 'AVAILABLE') === statusFilter;
    })
    .filter((r) => {
      if (!classFilter) return true;
      if (classFilter === 'SEDAN') return r.supportsSedan;
      if (classFilter === 'SUV') return r.supportsSuv;
      return true;
    })
    .filter((r) => {
      if (!capabilityFilter) return true;
      if (capabilityFilter === 'LIFT') return !!r.liftType && r.liftType !== 'mobile' && r.liftType !== 'power_jack';
      if (capabilityFilter === 'MOBILE_JACK') return r.liftType === 'mobile' || r.liftType === 'power_jack';
      if (capabilityFilter === 'ALIGNMENT') return r.hasAlignment;
      if (capabilityFilter === 'DIAGNOSTICS') return r.hasDiagnostics;
      if (capabilityFilter === 'GENERAL') return !r.liftType && !r.hasAlignment && !r.hasDiagnostics;
      return true;
    })
    .filter((r) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (sortBy === 'code') return a.code.localeCompare(b.code);
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'status') {
        const rank = (r: WorkResource) =>
          r.retiredAt ? 5 : ({ AVAILABLE: 0, MAINTENANCE: 2, TEMPORARILY_UNAVAILABLE: 3, OUT_OF_SERVICE: 4 } as Record<string, number>)[
            r.operationalStatus?.status ?? 'AVAILABLE'
          ] ?? 1;
        return rank(a) - rank(b) || a.displayOrder - b.displayOrder;
      }
      if (sortBy === 'updated') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return a.displayOrder - b.displayOrder || a.code.localeCompare(b.code);
    });

  // Grouped by type, retired gathered at the end: a manager scans "Bays" as a
  // block the way they scan the workshop floor, not as interleaved table rows.
  const grouped = new Map<string, WorkResource[]>();
  for (const r of filtered) {
    const key = r.retiredAt ? 'RETIRED' : r.resourceCategory;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const o = overviewQuery.data;

  return (
    <div className="page-container">
      <PageHeader
        title="Resources & Bays"
        subtitle="The bays, lifts and equipment this site schedules work onto — changes take effect immediately"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Setup' }, { label: 'Resources & Bays' }]}
        actions={
          <>
            {/*
              CR-2026-108 Stage 5B — the position count is worked out from what is
              confirmed here, and every existing row starts unconfirmed. The badge
              is the prompt: an unconfirmed bay contributes nothing, quietly.
            */}
            <Link
              href="/admin/resources/reconciliation"
              className="text-sm px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 inline-flex items-center gap-2"
            >
              Confirm Work Positions
              {unconfirmedCount > 0 && (
                <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800">
                  {unconfirmedCount}
                </span>
              )}
            </Link>
            <button onClick={() => setAdding(true)} className="btn-primary text-sm">
              Add Resource
            </button>
          </>
        }
      />

      {/* CR-2026-108 §22 — what the shop can actually work on, and whether the
          resource-aware model is safe to switch on. Above the operational strip
          because it answers the question a manager opens this screen to ask. */}
      <CapacitySummary siteId={siteId} />

      {/* Operational overview — counts a manager acts on, not analytics */}
      {o && (
        <div className="grid grid-cols-3 md:grid-cols-9 gap-2 mb-4">
          <Stat label="Active" value={o.totalActive} />
          <Stat label="Available now" value={o.availableNow} tone="good" />
          <Stat label="In use" value={o.inUse} />
          <Stat label="Maintenance" value={o.maintenance} tone={o.maintenance ? 'warn' : undefined} />
          <Stat label="Temp. unavailable" value={o.temporarilyUnavailable} tone={o.temporarilyUnavailable ? 'warn' : undefined} />
          <Stat label="Out of service" value={o.outOfService} tone={o.outOfService ? 'bad' : undefined} />
          <Stat label="Retired" value={o.retired} />
          <Stat label="Sedan bays" value={o.sedanBays} />
          <Stat label="SUV bays" value={o.suvBays} />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code or name…"
          className="input-field w-52 text-sm"
        />
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="input-field w-auto text-sm">
          <option value="">All types</option>
          {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input-field w-auto text-sm">
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
          <option value="RETIRED">Retired</option>
        </select>
        <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className="input-field w-auto text-sm">
          <option value="">Any vehicle class</option>
          <option value="SEDAN">Takes sedans</option>
          <option value="SUV">Takes SUVs</option>
        </select>
        <select value={capabilityFilter} onChange={(e) => setCapabilityFilter(e.target.value)} className="input-field w-auto text-sm">
          <option value="">Any capability</option>
          <option value="LIFT">Has a lift</option>
          <option value="MOBILE_JACK">Mobile / power jack</option>
          <option value="ALIGNMENT">Alignment equipment</option>
          <option value="DIAGNOSTICS">Diagnostics equipment</option>
          <option value="GENERAL">General (no special equipment)</option>
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="input-field w-auto text-sm">
          <option value="display">Sort: Board order</option>
          <option value="code">Sort: Code</option>
          <option value="name">Sort: Name</option>
          <option value="status">Sort: Needs attention first</option>
          <option value="updated">Sort: Recently changed</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired
        </label>
        <span className="text-[11px] text-slate-400 ml-auto">{filtered.length} of {data.length}</span>
      </div>

      {resQuery.isLoading && <LoadingState message="Loading resources..." />}
      {resQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Could not load resources.</p>
        </div>
      )}

      {!resQuery.isLoading && filtered.length === 0 && (
        <EmptyState
          title={data.length === 0 ? 'No resources configured yet' : 'Nothing matches these filters'}
          description={
            data.length === 0
              ? 'Add your first bay or piece of equipment — it becomes schedulable the moment it is saved.'
              : 'Clear a filter or two.'
          }
        />
      )}

      {filtered.length > 0 && (
        <div className="space-y-5">
          {GROUP_ORDER.filter((cat) => grouped.get(cat)?.length).map((cat) => (
            <section key={cat}>
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {GROUP_LABEL[cat] ?? cat}
                </h2>
                <span className="badge bg-slate-100 text-slate-500 text-[10px]">{grouped.get(cat)!.length}</span>
                <div className="flex-grow border-t border-slate-200" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {grouped.get(cat)!.map((r) => (
                  <ResourceCard
                    key={r.id}
                    resource={r}
                    onEdit={() => setEditing(r)}
                    onStatus={() => setStatusTarget(r)}
                    onHistory={() => setHistoryTarget(r)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {adding && <ResourceForm siteId={siteId} onClose={() => setAdding(false)} onSaved={refresh} />}
      {editing && (
        <ResourceForm siteId={siteId} existing={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      {statusTarget && (
        <StatusModal resource={statusTarget} onClose={() => setStatusTarget(null)} onSaved={refresh} />
      )}
      {historyTarget && <HistoryDrawer resource={historyTarget} onClose={() => setHistoryTarget(null)} />}
    </div>
  );
}

const GROUP_ORDER = ['BAY', 'OVERFLOW', 'LIGHT_SLOT', 'POWER_WASH', 'EXTERNAL', 'RETIRED'];
const GROUP_LABEL: Record<string, string> = {
  BAY: 'Service Bays',
  OVERFLOW: 'Overflow Spaces',
  LIGHT_SLOT: 'Light Slots',
  POWER_WASH: 'Power Wash',
  EXTERNAL: 'External',
  RETIRED: 'Retired',
};

/** Left stripe + badge tone per operational state — status reads before any text. */
const STATE_STRIPE: Record<string, string> = {
  AVAILABLE: 'bg-emerald-500',
  TEMPORARILY_UNAVAILABLE: 'bg-amber-500',
  MAINTENANCE: 'bg-orange-500',
  OUT_OF_SERVICE: 'bg-red-500',
  RETIRED: 'bg-slate-400',
};

function ResourceCard({
  resource: r, onEdit, onStatus, onHistory,
}: {
  resource: WorkResource;
  onEdit: () => void;
  onStatus: () => void;
  onHistory: () => void;
}) {
  const state = r.retiredAt ? 'RETIRED' : (r.operationalStatus?.status ?? 'AVAILABLE');
  const occupied = r.occupancy?.status === 'OCCUPIED';
  const caps = capabilitySummary(r);
  const down = state !== 'AVAILABLE' && state !== 'RETIRED';

  return (
    <div className={`relative card overflow-hidden flex flex-col ${r.retiredAt ? 'opacity-70' : ''}`}>
      <span className={`absolute inset-y-0 left-0 w-1 ${STATE_STRIPE[state] ?? 'bg-slate-300'}`} />
      <div className="pl-4 pr-3 pt-3 pb-2 flex-grow">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] font-semibold text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">
                {r.code}
              </span>
              {occupied && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-blue-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  In use
                </span>
              )}
            </div>
            <div className="text-sm font-semibold text-slate-900 mt-1 truncate">{r.name}</div>
          </div>
          <span
            className={`badge text-[10px] shrink-0 ${r.retiredAt ? 'bg-slate-200 text-slate-600' : (STATUS_BADGE[state] ?? 'bg-slate-100 text-slate-600')}`}
            title={r.retiredAt ? (r.retireReason ?? '') : (r.operationalStatus?.reason ?? '')}
          >
            {r.retiredAt ? 'Retired' : (STATUS_LABEL[state] ?? state)}
          </span>
        </div>

        {/*
          CR-2026-108 §21 — does this count as an independent vehicle work
          position, and what work can happen on it? Shown on the card because a
          bay that contributes nothing looks identical to one that does until you
          say so, and "we opened Bay 6 but the board never changed" is exactly the
          confusion that costs an afternoon.
        */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <span className={`badge text-[10px] ${ROLE_BADGE[r.capacityRole ?? 'UNVERIFIED'] ?? 'bg-slate-100 text-slate-600'}`}>
            {ROLE_LABEL[r.capacityRole ?? 'UNVERIFIED'] ?? r.capacityRole}
          </span>
          {(r.serviceCapabilities ?? []).map((c) => (
            <span key={c.capability} className="badge bg-sky-50 text-sky-700 text-[10px] border border-sky-200">
              {WORK_LABEL[c.capability] ?? c.capability}
            </span>
          ))}
          <span className="badge bg-indigo-50 text-indigo-700 text-[10px]">{vehicleClassLabel(r)}</span>
          {caps.split(' · ').map((cap) => (
            <span key={cap} className="badge bg-slate-50 text-slate-600 text-[10px] border border-slate-200">{cap}</span>
          ))}
          {!r.schedulingEnabled && !r.retiredAt && (
            <span className="badge bg-slate-100 text-slate-500 text-[10px]">not scheduled</span>
          )}
          {!r.isActive && !r.retiredAt && (
            <span className="badge bg-slate-100 text-slate-500 text-[10px]">inactive</span>
          )}
        </div>

        {/* Why it is down, and when it comes back — on the card, not behind a click */}
        {down && (r.operationalStatus?.reason || r.operationalStatus?.expectedReturnAt) && (
          <p className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded px-2 py-1">
            {r.operationalStatus?.reason ?? ''}
            {r.operationalStatus?.expectedReturnAt &&
              ` — expected back ${new Date(r.operationalStatus.expectedReturnAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
          </p>
        )}
        {r.retiredAt && r.retireReason && (
          <p className="mt-2 text-[11px] text-slate-500 truncate" title={r.retireReason}>{r.retireReason}</p>
        )}
      </div>

      <div className="pl-4 pr-3 py-2 border-t border-slate-100 flex gap-1.5">
        {!r.retiredAt && (
          <>
            <button onClick={onEdit} className="btn-secondary text-[11px] py-1 px-2.5">Edit</button>
            <button onClick={onStatus} className="btn-secondary text-[11px] py-1 px-2.5">Set Status</button>
          </>
        )}
        <button onClick={onHistory} className="btn-secondary text-[11px] py-1 px-2.5 ml-auto">History</button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' | 'bad' }) {
  const colour =
    tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900';
  return (
    <div className="card p-2.5 text-center">
      <div className={`text-lg font-bold tabular-nums ${colour}`}>{value}</div>
      <div className="text-[10px] text-slate-500 leading-tight">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit
// ---------------------------------------------------------------------------

function ResourceForm({
  siteId,
  existing,
  onClose,
  onSaved,
}: {
  siteId: string;
  existing?: WorkResource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(
    existing
      ? {
          code: existing.code,
          name: existing.name,
          resourceCategory: existing.resourceCategory,
          liftType: existing.liftType ?? '',
          hasAlignment: existing.hasAlignment,
          hasDiagnostics: existing.hasDiagnostics,
          requiresMechanic: existing.requiresMechanic,
          showOnDispatchBoard: existing.showOnDispatchBoard,
          supportsSedan: existing.supportsSedan,
          supportsSuv: existing.supportsSuv,
          schedulingEnabled: existing.schedulingEnabled,
          capacity: existing.capacity,
          displayOrder: existing.displayOrder,
          notes: existing.notes ?? '',
        }
      : EMPTY_FORM,
  );

  // The §29 impact numbers, so a manager sees what a capability change touches
  // BEFORE saving, not in a support call afterwards.
  const impactQuery = useQuery<Impact>({
    queryKey: ['resource-impact', existing?.id],
    queryFn: () => api.get(`/resources/${existing!.id}/impact`),
    enabled: !!existing,
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        liftType: form.liftType || null,
        notes: form.notes || null,
        capacity: Number(form.capacity),
        displayOrder: Number(form.displayOrder),
      };
      return existing
        ? api.patch(`/resources/${existing.id}`, { ...payload, expectedUpdatedAt: existing.updatedAt })
        : api.post('/resources', { ...payload, siteId });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/resources/${existing!.id}`),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const retire = useMutation({
    mutationFn: (reason: string) => api.post(`/resources/${existing!.id}/retire`, { reason }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const impact = impactQuery.data;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-start justify-center overflow-y-auto py-8">
      <div className="card w-full max-w-lg mx-4">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            {existing ? `Edit ${existing.name}` : 'Add Resource'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
        </div>
        <div className="card-body space-y-3">
          {existing && impact && (impact.futureReservations > 0 || impact.activeAssignments > 0 || impact.occupiedNow) && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {existing.name} currently has{' '}
              {[
                impact.occupiedNow ? 'a vehicle on it' : null,
                impact.activeAssignments ? `${impact.activeAssignments} active assignment(s)` : null,
                impact.futureReservations ? `${impact.futureReservations} upcoming reservation(s)` : null,
              ]
                .filter(Boolean)
                .join(', ')}
              . Changing its availability or capabilities may affect that work.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="input-label">Code</span>
              <input value={form.code} onChange={(e) => set('code', e.target.value)} className="input-field" placeholder="BAY-6" />
            </label>
            <label className="block">
              <span className="input-label">Name</span>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} className="input-field" placeholder="Bay 6" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="input-label">Type</span>
              <select
                value={form.resourceCategory}
                onChange={(e) => set('resourceCategory', e.target.value)}
                className="input-field"
                disabled={!!existing}
                title={existing ? 'The type defines behaviour and does not change after creation.' : undefined}
              >
                {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="input-label">Lift / equipment</span>
              <select value={form.liftType} onChange={(e) => set('liftType', e.target.value)} className="input-field">
                <option value="">None</option>
                <option value="sedan">Sedan lift</option>
                <option value="heavy">Heavy lift</option>
                <option value="mobile">Mobile jack</option>
                <option value="power_jack">Power jack</option>
              </select>
            </label>
          </div>

          <div>
            <span className="input-label">Vehicle classes this resource can take</span>
            <div className="flex gap-4 mt-1">
              <label className="flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form.supportsSedan} onChange={(e) => set('supportsSedan', e.target.checked)} />
                Sedan
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form.supportsSuv} onChange={(e) => set('supportsSuv', e.target.checked)} />
                SUV
              </label>
            </div>
            {form.liftType === 'mobile' && form.supportsSuv && (
              <p className="text-[11px] text-amber-700 mt-1">
                Mobile jacks are sedan-only by the shop&apos;s safety rule. Ticking SUV here does not bypass it —
                an SUV assignment will still need an audited manager override.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {(
              [
                ['hasAlignment', 'Alignment equipment'],
                ['hasDiagnostics', 'Diagnostics equipment'],
                ['requiresMechanic', 'Requires a mechanic'],
                ['showOnDispatchBoard', 'Show on dispatch board'],
                ['schedulingEnabled', 'Accepts scheduled work'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form[key]} onChange={(e) => set(key, e.target.checked)} />
                {label}
              </label>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="input-label">Capacity (concurrent jobs)</span>
              <input
                type="number"
                min={1}
                value={form.capacity}
                onChange={(e) => set('capacity', Number(e.target.value))}
                className="input-field"
              />
            </label>
            <label className="block">
              <span className="input-label">Display order</span>
              <input
                type="number"
                value={form.displayOrder}
                onChange={(e) => set('displayOrder', Number(e.target.value))}
                className="input-field"
              />
            </label>
          </div>

          <label className="block">
            <span className="input-label">Internal notes</span>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} className="input-field" rows={2} />
          </label>

          {save.isError && (
            <p className="text-xs text-red-600">{errText(save.error, 'Could not save.')}</p>
          )}
          {remove.isError && (
            <p className="text-xs text-red-600">{errText(remove.error, 'Could not delete.')}</p>
          )}
          {retire.isError && (
            <p className="text-xs text-red-600">{errText(retire.error, 'Could not retire.')}</p>
          )}

          <div className="flex items-center justify-between pt-1">
            <div className="flex gap-2">
              {existing && impact && !impact.everUsed && (
                <button
                  onClick={() => {
                    if (confirm(`Delete ${existing.name}? It has never been used, so this removes it completely.`)) {
                      remove.mutate();
                    }
                  }}
                  className="btn-secondary text-xs text-red-600"
                  disabled={remove.isPending}
                >
                  Delete
                </button>
              )}
              {existing && impact && impact.everUsed && (
                <button
                  onClick={() => {
                    const reason = prompt(
                      `Retire ${existing.name}? It keeps all its history and stops taking new work. Enter the reason:`,
                    );
                    if (reason?.trim()) retire.mutate(reason.trim());
                  }}
                  className="btn-secondary text-xs text-red-600"
                  disabled={retire.isPending}
                >
                  Retire
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
                {save.isPending ? 'Saving…' : existing ? 'Save Changes' : 'Create Resource'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Set Status
// ---------------------------------------------------------------------------

function StatusModal({
  resource,
  onClose,
  onSaved,
}: {
  resource: WorkResource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = resource.operationalStatus?.status ?? 'AVAILABLE';
  const [status, setStatus] = useState(current);
  const [reason, setReason] = useState('');
  const [expectedReturn, setExpectedReturn] = useState('');

  const save = useMutation({
    mutationFn: () =>
      api.post(`/resources/${resource.id}/status`, {
        status,
        reason: reason || undefined,
        expectedReturnAt: expectedReturn ? new Date(expectedReturn).toISOString() : undefined,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center">
      <div className="card w-full max-w-sm mx-4">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Set status — {resource.name}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
        </div>
        <div className="card-body space-y-3">
          <label className="block">
            <span className="input-label">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input-field">
              <option value="AVAILABLE">Available — accepts work normally</option>
              <option value="TEMPORARILY_UNAVAILABLE">Temporarily Unavailable — short hold, expected back soon</option>
              <option value="MAINTENANCE">Maintenance — being serviced or repaired</option>
              <option value="OUT_OF_SERVICE">Out of Service — down until further notice</option>
            </select>
          </label>

          {status !== 'AVAILABLE' && (
            <>
              <label className="block">
                <span className="input-label">Reason (shown on the board and in history)</span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="input-field"
                  placeholder="Lift repair, electrical fault…"
                />
              </label>
              <label className="block">
                <span className="input-label">Expected back (optional)</span>
                <input
                  type="datetime-local"
                  value={expectedReturn}
                  onChange={(e) => setExpectedReturn(e.target.value)}
                  className="input-field"
                />
              </label>
              <p className="text-[11px] text-slate-500">
                While not Available, {resource.name} refuses new assignments. Existing work and history are untouched.
              </p>
            </>
          )}

          {save.isError && <p className="text-xs text-red-600">{errText(save.error, 'Could not change status.')}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Set Status'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Change history
// ---------------------------------------------------------------------------

function HistoryDrawer({ resource, onClose }: { resource: WorkResource; onClose: () => void }) {
  const q = useQuery<HistoryEvent[]>({
    queryKey: ['resource-history', resource.id],
    queryFn: () => api.get(`/resources/${resource.id}/history`),
  });

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center">
      <div className="card w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Change history — {resource.name}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
        </div>
        <div className="card-body overflow-y-auto">
          {q.isLoading && <LoadingState message="Loading history..." />}
          {q.data && q.data.length === 0 && (
            <p className="text-sm text-slate-500">No configuration changes recorded.</p>
          )}
          {q.data && q.data.length > 0 && (
            <div className="space-y-2">
              {q.data.map((e) => (
                <div key={e.id} className="border-b border-slate-100 pb-2 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-slate-900">{ACTION_LABEL[e.action] ?? e.action}</span>
                    <span className="text-[10px] text-slate-400 whitespace-nowrap">
                      {new Date(e.at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    by {e.by}
                    {e.reason ? ` — ${e.reason}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
