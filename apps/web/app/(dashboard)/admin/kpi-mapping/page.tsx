'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';

/**
 * CR-2026-090 — administering the KPI package-component mapping.
 *
 * This screen decides which services count towards a benchmark package, so the two
 * rules the backend enforces have to be visible here rather than only discovered
 * when a save is refused:
 *
 *  1. A mapping is superseded, never edited or deleted. Jobs measured under the old
 *     mapping keep being explained by it.
 *  2. Several services can resolve to the SAME component. A manager must be able to
 *     see that DISC-01 and BRK-02 are two doors into one room, not two separate time
 *     allowances, because an order carrying both still counts Front Brakes once.
 *
 * CR-2026-092 extends the mapping from "which component" to "what it contributes":
 * a mode, where its minutes come from, and what those minutes currently are. Two of
 * those states are silent failures and so are surfaced as their own banners and
 * filters — a provisional duration is a seeded stand-in nobody has confirmed, and an
 * incomplete configuration looks mapped while producing no standard at all.
 */

const ALLOWED_ROLES = ['ADMIN'];

const UNMAPPED_FILTER = '__UNMAPPED__';

const UNSET_CONTRIBUTION_FILTER = '__UNSET__';

/** Mirrors the server's tolerance in KpiMappingService.upsert — kept so the screen refuses before the round trip. */
const BACKDATE_TOLERANCE_MS = 60_000;

const ROLE_BADGE: Record<string, string> = {
  GENERAL_SERVICE_CORE: 'bg-blue-50 text-blue-700',
  FRONT_BRAKES: 'bg-indigo-50 text-indigo-700',
  SPARK_PLUGS: 'bg-violet-50 text-violet-700',
  INCLUDED_NO_ADDITIONAL_BENCHMARK: 'bg-slate-100 text-slate-600',
  FORCES_CUSTOM_BENCHMARK: 'bg-amber-50 text-amber-700',
};

const ROLE_HINT: Record<string, string> = {
  GENERAL_SERVICE_CORE: 'Satisfies the General Service component of a benchmark package.',
  FRONT_BRAKES:
    'Satisfies the Front Brakes component. Require an axle qualifier so rear-only work cannot quietly satisfy it.',
  SPARK_PLUGS: 'Satisfies the Spark Plugs component.',
  INCLUDED_NO_ADDITIONAL_BENCHMARK:
    'Work the general-service standard already covers. Adds no extra time and does not stop a job being benchmarked.',
  FORCES_CUSTOM_BENCHMARK:
    'Work no approved package describes. A job containing it is measured as Custom (not benchmarked).',
};

const CONTRIBUTION_BADGE: Record<string, string> = {
  PACKAGE_COMPONENT: 'bg-blue-50 text-blue-700',
  INCLUDED_IN_BASE: 'bg-slate-100 text-slate-600',
  ADDITIVE_STANDARD: 'bg-emerald-50 text-emerald-700',
  SEPARATE_SLA: 'bg-cyan-50 text-cyan-700',
  CONDITIONAL: 'bg-violet-50 text-violet-700',
  CUSTOM_ONLY: 'bg-amber-50 text-amber-700',
};

const CONTRIBUTION_HINT: Record<string, string> = {
  PACKAGE_COMPONENT:
    'Identifies which manager package the job is measured against. The package matrix supplies the time, not this service.',
  INCLUDED_IN_BASE:
    'The base standard already covers this work. It adds no time and does not stop a job being benchmarked.',
  ADDITIVE_STANDARD: 'Adds its own time on top of the package standard.',
  SEPARATE_SLA:
    'Measured against its own service level. It is not counted as technician time on the job.',
  CONDITIONAL:
    'Counts only where the work-order line carries the qualifier below. Without one it contributes nothing.',
  CUSTOM_ONLY:
    'No approved package describes this work. A job containing it is measured as Custom (not benchmarked).',
};

const DURATION_SOURCE_HINT: Record<string, string> = {
  MANAGER_PACKAGE:
    "The benchmark package supplies the time. The service adds nothing of its own on top.",
  SERVICE_CATALOG_DURATION:
    'The minutes come from this code’s entry in the service catalogue, not from anything set here. Change the catalogue duration and this follows it.',
  FIXED_CONFIGURED_DURATION:
    'The minutes are set here and stay put whatever the service catalogue says.',
  NO_DURATION: 'Contributes no time at all.',
};

/**
 * GET /kpi/mappings returns vocabularies for the contribution mode and duration
 * source only, so these two are held here. Kept in step with KPI_ALLOWANCE_BASES and
 * KPI_REQUIRED_QUALIFIERS in the API's kpi-mapping DTO.
 */
const ALLOWANCE_BASES: { value: string; label: string }[] = [
  { value: 'PER_JOB', label: 'Once per job' },
  { value: 'PER_SERVICE_LINE', label: 'Per service line' },
  { value: 'PER_UNIT', label: 'Per unit' },
];

const REQUIRED_QUALIFIERS: { value: string; label: string }[] = [
  { value: 'NONE', label: 'None' },
  { value: 'BRAKE', label: 'Brake — axle stated' },
  { value: 'TIRE_OPERATION', label: 'Tyre operation stated' },
];

const ALLOWANCE_BASIS_LABELS = new Map(ALLOWANCE_BASES.map((b) => [b.value, b.label]));
const QUALIFIER_LABELS = new Map(REQUIRED_QUALIFIERS.map((q) => [q.value, q.label]));

interface RoleOption {
  value: string;
  label: string;
}

interface MappingRow {
  serviceTypeId: string;
  code: string;
  name: string;
  family: string;
  serviceIsActive: boolean;
  mappingId: string | null;
  componentRole: string | null;
  componentRoleLabel: string | null;
  requiresAxleQualifier: boolean;
  contributionMode: string | null;
  durationSource: string | null;
  allowanceBasis: string | null;
  requiredQualifier: string | null;
  provisionalDuration: boolean;
  isSupersededCode: boolean;
  /** What the service contributes today, already resolved from its duration source. */
  sedanMinutes: number | null;
  suvMinutes: number | null;
  catalogueMinutes: number | null;
  incompleteConfiguration: boolean;
  effectiveFrom: string | null;
  notes: string | null;
  updatedByUserId: string | null;
  updatedByName: string | null;
  aliasOf: string[];
  timesUsed: number;
  needsReview: boolean;
}

interface MappingsResponse {
  rows: MappingRow[];
  roles: RoleOption[];
  contributionModes: RoleOption[];
  durationSources: RoleOption[];
  unmappedCount: number;
  provisionalCount: number;
  incompleteCount: number;
}

interface HistoryEntry {
  id: string;
  serviceTypeId: string;
  componentRole: string;
  requiresAxleQualifier: boolean;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByName: string | null;
}

interface StaffMember {
  id: string;
  fullName: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A null author is seeded rather than anonymous, and the screen says so. */
function actorLabel(
  name: string | null,
  userId: string | null,
  directory: Map<string, string>,
): string {
  if (!userId) return 'seeded';
  return name ?? directory.get(userId) ?? 'unknown user';
}

/**
 * What the service contributes, for one vehicle class.
 *
 * A bare dash would make three different situations look identical: a package base
 * that legitimately carries no per-service time, a source that adds none by design,
 * and a fixed duration nobody has filled in.
 */
function minutesLabel(value: number | null, durationSource: string | null): string {
  if (value !== null) return `${value} min`;
  switch (durationSource) {
    case 'MANAGER_PACKAGE':
      return 'from package';
    case 'NO_DURATION':
      return 'none';
    default:
      return 'not set';
  }
}

/**
 * Seeds for the fixed-minute inputs.
 *
 * The list returns the resolved contribution rather than the stored figure, and the
 * resolver short-circuits INCLUDED_IN_BASE and SEPARATE_SLA to zero — so under those
 * modes the stored figure is not visible from here and the input starts blank. Blank
 * is safe: an omitted field carries the stored figure forward.
 */
function fixedSeeds(row: MappingRow): { sedan: string; suv: string } {
  const usesFixed =
    row.durationSource === 'FIXED_CONFIGURED_DURATION' &&
    row.contributionMode !== 'INCLUDED_IN_BASE' &&
    row.contributionMode !== 'SEPARATE_SLA';
  if (!usesFixed) return { sedan: '', suv: '' };
  return {
    sedan: row.sedanMinutes !== null ? String(row.sedanMinutes) : '',
    // The resolver falls back to the sedan figure, so an SUV value equal to it is
    // inherited rather than configured — seeding it would make it look deliberate.
    suv:
      row.suvMinutes !== null && row.suvMinutes !== row.sedanMinutes
        ? String(row.suvMinutes)
        : '',
  };
}

const BANNER_TONE = {
  amber: {
    frame: 'border-amber-200 bg-amber-50',
    title: 'text-amber-900',
    body: 'text-amber-800',
  },
  red: {
    frame: 'border-red-200 bg-red-50',
    title: 'text-red-900',
    body: 'text-red-800',
  },
} as const;

function CountBanner({
  tone,
  title,
  children,
  onShow,
}: {
  tone: keyof typeof BANNER_TONE;
  title: string;
  children: ReactNode;
  onShow: () => void;
}) {
  const t = BANNER_TONE[tone];
  return (
    <div className={`card ${t.frame} p-4 mb-4`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className={`text-sm font-semibold ${t.title}`}>{title}</h2>
          <p className={`text-xs ${t.body} mt-1 max-w-2xl`}>{children}</p>
        </div>
        <button onClick={onShow} className="btn-secondary py-1.5 px-3 text-xs shrink-0">
          Show these
        </button>
      </div>
    </div>
  );
}

export default function KpiMappingPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [familyFilter, setFamilyFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [contributionFilter, setContributionFilter] = useState('');
  const [onlyReview, setOnlyReview] = useState(false);
  const [onlyProvisional, setOnlyProvisional] = useState(false);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [includeRetired, setIncludeRetired] = useState(false);

  const [editing, setEditing] = useState<MappingRow | null>(null);
  const [editRole, setEditRole] = useState('');
  const [editAxle, setEditAxle] = useState(false);
  const [editNotes, setEditNotes] = useState('');
  const [editEffectiveFrom, setEditEffectiveFrom] = useState('');
  const [editContributionMode, setEditContributionMode] = useState('');
  const [editDurationSource, setEditDurationSource] = useState('');
  const [editAllowanceBasis, setEditAllowanceBasis] = useState('');
  const [editRequiredQualifier, setEditRequiredQualifier] = useState('');
  const [editSedanMinutes, setEditSedanMinutes] = useState('');
  const [editSuvMinutes, setEditSuvMinutes] = useState('');
  const [editProvisional, setEditProvisional] = useState(false);
  const [editSuperseded, setEditSuperseded] = useState(false);

  const [deactivating, setDeactivating] = useState<MappingRow | null>(null);
  const [deactivateReason, setDeactivateReason] = useState('');

  const [historyFor, setHistoryFor] = useState<MappingRow | null>(null);

  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');

  const mappingsQuery = useQuery<MappingsResponse>({
    queryKey: ['kpi-mappings'],
    queryFn: () => api.get('/kpi/mappings'),
    enabled: allowed,
  });

  // The mapping rows carry only a user id; the staff directory turns that into the
  // name a manager can actually act on.
  const staffQuery = useQuery<StaffMember[]>({
    queryKey: ['staff', 'kpi-mapping-actors'],
    queryFn: () => api.get('/staff'),
    enabled: allowed,
  });

  const historyQuery = useQuery<HistoryEntry[]>({
    queryKey: ['kpi-mapping-history', historyFor?.serviceTypeId],
    queryFn: () => api.get(`/kpi/mappings/${historyFor?.serviceTypeId}/history`),
    enabled: !!historyFor,
  });

  const saveMutation = useMutation({
    mutationFn: (body: {
      serviceTypeId: string;
      componentRole: string;
      requiresAxleQualifier: boolean;
      notes?: string;
      effectiveFrom?: string;
      contributionMode?: string;
      durationSource?: string;
      allowanceBasis?: string;
      requiredQualifier?: string;
      fixedSedanMinutes?: number;
      fixedSuvMinutes?: number;
      provisionalDuration?: boolean;
      isSupersededCode?: boolean;
    }) => api.post('/kpi/mappings', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kpi-mappings'] });
      queryClient.invalidateQueries({ queryKey: ['kpi-mapping-history'] });
      closeEdit();
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: ({ mappingId, reason }: { mappingId: string; reason: string }) =>
      api.post(`/kpi/mappings/${mappingId}/deactivate`, reason ? { reason } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kpi-mappings'] });
      queryClient.invalidateQueries({ queryKey: ['kpi-mapping-history'] });
      setDeactivating(null);
      setDeactivateReason('');
    },
  });

  const data = mappingsQuery.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const roles = data?.roles ?? [];
  const contributionModes = useMemo(() => data?.contributionModes ?? [], [data]);
  const durationSources = useMemo(() => data?.durationSources ?? [], [data]);

  const roleLabels = useMemo(
    () => new Map(roles.map((r) => [r.value, r.label])),
    [roles],
  );
  // The server owns this vocabulary, so its labels are used rather than a second set
  // invented here that would drift the moment a mode is added.
  const contributionLabels = useMemo(
    () => new Map(contributionModes.map((m) => [m.value, m.label])),
    [contributionModes],
  );
  const durationSourceLabels = useMemo(
    () => new Map(durationSources.map((d) => [d.value, d.label])),
    [durationSources],
  );
  const actorNames = useMemo(
    () => new Map((staffQuery.data ?? []).map((s) => [s.id, s.fullName])),
    [staffQuery.data],
  );
  const families = useMemo(
    () => [...new Set(rows.map((r) => r.family))].sort(),
    [rows],
  );

  /**
   * Groups of services resolving to one component. Derived from the server's own
   * alias list rather than recomputed here — which services count as benchmark
   * components is the scheduler's rule, not this screen's.
   */
  const aliasGroups = useMemo(() => {
    const groups = new Map<string, MappingRow[]>();
    for (const r of rows) {
      if (!r.componentRole || r.aliasOf.length === 0) continue;
      const group = groups.get(r.componentRole) ?? [];
      group.push(r);
      groups.set(r.componentRole, group);
    }
    return [...groups.entries()].map(([role, members]) => ({
      role,
      members,
      // Aliases that disagree on the axle qualifier are a genuine hole: the lax alias
      // lets rear-only work satisfy a standard the strict one would have refused.
      axleConflict: new Set(members.map((m) => m.requiresAxleQualifier)).size > 1,
    }));
  }, [rows]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!includeRetired && !r.serviceIsActive) return false;
      if (onlyReview && !(r.needsReview && r.serviceIsActive)) return false;
      if (onlyProvisional && !r.provisionalDuration) return false;
      if (onlyIncomplete && !r.incompleteConfiguration) return false;
      if (familyFilter && r.family !== familyFilter) return false;
      if (roleFilter === UNMAPPED_FILTER && r.componentRole) return false;
      if (roleFilter && roleFilter !== UNMAPPED_FILTER && r.componentRole !== roleFilter) return false;
      if (contributionFilter === UNSET_CONTRIBUTION_FILTER && r.contributionMode) return false;
      if (
        contributionFilter &&
        contributionFilter !== UNSET_CONTRIBUTION_FILTER &&
        r.contributionMode !== contributionFilter
      ) {
        return false;
      }
      if (!term) return true;
      return (
        r.code.toLowerCase().includes(term) ||
        r.name.toLowerCase().includes(term) ||
        r.family.toLowerCase().includes(term)
      );
    });
  }, [
    rows,
    search,
    familyFilter,
    roleFilter,
    contributionFilter,
    onlyReview,
    onlyProvisional,
    onlyIncomplete,
    includeRetired,
  ]);

  /**
   * A banner narrows the list to its own outstanding work. The other narrowing
   * filters are cleared with it, because landing on an empty table after asking to
   * see 12 provisional durations reads as a bug rather than as a leftover filter.
   */
  function focusOn(kind: 'unmapped' | 'provisional' | 'incomplete') {
    setSearch('');
    setFamilyFilter('');
    setRoleFilter('');
    setContributionFilter('');
    setOnlyReview(kind === 'unmapped');
    setOnlyProvisional(kind === 'provisional');
    setOnlyIncomplete(kind === 'incomplete');
  }

  function openEdit(row: MappingRow, preset?: { role: string; axle: boolean }) {
    const seeds = fixedSeeds(row);
    setEditing(row);
    setEditRole(preset?.role ?? row.componentRole ?? '');
    setEditAxle(preset?.axle ?? row.requiresAxleQualifier);
    setEditNotes('');
    setEditEffectiveFrom('');
    setEditContributionMode(row.contributionMode ?? '');
    setEditDurationSource(row.durationSource ?? '');
    setEditAllowanceBasis(row.allowanceBasis ?? 'PER_JOB');
    setEditRequiredQualifier(row.requiredQualifier ?? 'NONE');
    setEditSedanMinutes(seeds.sedan);
    setEditSuvMinutes(seeds.suv);
    setEditProvisional(row.provisionalDuration);
    setEditSuperseded(row.isSupersededCode);
    saveMutation.reset();
  }

  function closeEdit() {
    setEditing(null);
    setEditRole('');
    setEditAxle(false);
    setEditNotes('');
    setEditEffectiveFrom('');
    setEditContributionMode('');
    setEditDurationSource('');
    setEditAllowanceBasis('');
    setEditRequiredQualifier('');
    setEditSedanMinutes('');
    setEditSuvMinutes('');
    setEditProvisional(false);
    setEditSuperseded(false);
  }

  const editIsBackdated =
    editEffectiveFrom !== '' &&
    !Number.isNaN(new Date(editEffectiveFrom).getTime()) &&
    new Date(editEffectiveFrom).getTime() < Date.now() - BACKDATE_TOLERANCE_MS;

  const editSeeds = editing ? fixedSeeds(editing) : { sedan: '', suv: '' };

  // The server treats an identical classification as a no-op rather than a supersede,
  // so notes typed on their own would silently go nowhere. The classification is role,
  // axle and the whole contribution policy — but NOT the provisional or out-of-use
  // flags, which is why they are checked separately below.
  const editIsNoOp =
    !!editing &&
    editing.componentRole === editRole &&
    editing.requiresAxleQualifier === editAxle &&
    (editing.contributionMode ?? '') === editContributionMode &&
    (editing.durationSource ?? '') === editDurationSource &&
    (editing.allowanceBasis ?? 'PER_JOB') === editAllowanceBasis &&
    (editing.requiredQualifier ?? 'NONE') === editRequiredQualifier &&
    editSedanMinutes === editSeeds.sedan &&
    editSuvMinutes === editSeeds.suv;

  // Those two flags ride along with a new mapping; they do not create one. Toggling
  // only them saves nothing, and a manager who thinks they have just confirmed a
  // provisional figure would carry on believing it.
  const editIsFlagOnly =
    !!editing &&
    editIsNoOp &&
    (editProvisional !== editing.provisionalDuration ||
      editSuperseded !== editing.isSupersededCode);

  function submitEdit() {
    if (!editing || !editRole || !editContributionMode || !editDurationSource || editIsBackdated) {
      return;
    }
    const effectiveFrom = editEffectiveFrom ? new Date(editEffectiveFrom) : null;
    const sedan = Number.parseInt(editSedanMinutes, 10);
    const suv = Number.parseInt(editSuvMinutes, 10);

    // Only what changed. Every omitted contribution field carries forward from the row
    // being superseded, and the fixed minutes are not always readable from the list —
    // sending a value this screen only inferred would overwrite the stored one.
    saveMutation.mutate({
      serviceTypeId: editing.serviceTypeId,
      componentRole: editRole,
      requiresAxleQualifier: editAxle,
      ...(editContributionMode !== (editing.contributionMode ?? '') && {
        contributionMode: editContributionMode,
      }),
      ...(editDurationSource !== (editing.durationSource ?? '') && {
        durationSource: editDurationSource,
      }),
      ...(editAllowanceBasis !== (editing.allowanceBasis ?? '') && {
        allowanceBasis: editAllowanceBasis,
      }),
      ...(editRequiredQualifier !== (editing.requiredQualifier ?? '') && {
        requiredQualifier: editRequiredQualifier,
      }),
      ...(editSedanMinutes !== editSeeds.sedan &&
        Number.isFinite(sedan) &&
        sedan > 0 && { fixedSedanMinutes: sedan }),
      ...(editSuvMinutes !== editSeeds.suv &&
        Number.isFinite(suv) &&
        suv > 0 && { fixedSuvMinutes: suv }),
      ...(editProvisional !== editing.provisionalDuration && {
        provisionalDuration: editProvisional,
      }),
      ...(editSuperseded !== editing.isSupersededCode && { isSupersededCode: editSuperseded }),
      ...(editNotes.trim() && { notes: editNotes.trim() }),
      ...(effectiveFrom && !Number.isNaN(effectiveFrom.getTime()) && {
        effectiveFrom: effectiveFrom.toISOString(),
      }),
    });
  }

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="KPI Mapping" subtitle="Manager configuration" />
        <div className="card p-6 text-sm text-slate-600">
          You do not have permission to configure KPI mappings.
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title="KPI Mapping"
        subtitle="Which services count towards a benchmark package, and how"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Admin' }, { label: 'KPI Mapping' }]}
      />

      {mappingsQuery.isLoading && <LoadingState message="Loading service mappings..." />}

      {mappingsQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">
            {errorMessage(mappingsQuery.error, 'Failed to load KPI mappings.')}
          </p>
        </div>
      )}

      {data && (
        <>
          {data.unmappedCount > 0 && (
            <CountBanner
              tone="amber"
              title={`${data.unmappedCount} active service${data.unmappedCount === 1 ? '' : 's'} not mapped`}
              onShow={() => focusOn('unmapped')}
            >
              A work order containing an unmapped service cannot be matched to an approved
              package, so the whole job is measured as Custom (not benchmarked) and drops out
              of technician comparison. Map every service you expect to appear on a job.
            </CountBanner>
          )}

          {data.incompleteCount > 0 && (
            <CountBanner
              tone="red"
              title={`${data.incompleteCount} service${data.incompleteCount === 1 ? '' : 's'} cannot produce a standard`}
              onShow={() => focusOn('incomplete')}
            >
              These are mapped but incomplete — a catalogue duration that is missing, a fixed
              duration nobody set, or a conditional service with no qualifier to test. They look
              configured on every other screen while contributing nothing, so a job carrying one
              is measured against a standard that is quietly too short.
            </CountBanner>
          )}

          {data.provisionalCount > 0 && (
            <CountBanner
              tone="amber"
              title={`${data.provisionalCount} provisional duration${data.provisionalCount === 1 ? '' : 's'} awaiting confirmation`}
              onShow={() => focusOn('provisional')}
            >
              These minutes are seeded stand-ins, not figures management has agreed. Technicians
              are being measured against them today. Open each one and enter the confirmed figure
              — saving a real duration clears the provisional mark.
            </CountBanner>
          )}

          {aliasGroups.length > 0 && (
            <div className="card p-4 mb-4">
              <h2 className="text-sm font-semibold text-slate-900">Shared components (aliases)</h2>
              <p className="text-xs text-slate-500 mt-1 max-w-3xl">
                Each group below is one benchmark component reached through several service codes.
                They are not separate time allowances: an order carrying two codes from the same
                group still counts that component once, against one standard.
              </p>
              <div className="mt-3 space-y-2">
                {aliasGroups.map((g) => (
                  <div key={g.role} className="rounded-md border border-slate-200 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`badge text-[11px] ${ROLE_BADGE[g.role] ?? 'bg-slate-100 text-slate-600'}`}>
                        {roleLabels.get(g.role) ?? g.role}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {g.members.length} services, one allowance
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {g.members.map((m) => (
                        <span
                          key={m.serviceTypeId}
                          title={m.name}
                          className="font-mono text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5"
                        >
                          {m.code}
                          {m.requiresAxleQualifier && <span className="text-slate-400"> · axle</span>}
                        </span>
                      ))}
                    </div>
                    {g.axleConflict && (
                      <p className="text-[11px] text-red-700 mt-2">
                        These aliases disagree on the axle qualifier. The codes without it let
                        rear-only work satisfy this component, which the codes with it refuse —
                        set them the same way.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4 mb-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label className="input-label">Search</label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Code, name or family..."
                className="input-field"
              />
            </div>
            <div>
              <label className="input-label">Family</label>
              <select
                value={familyFilter}
                onChange={(e) => setFamilyFilter(e.target.value)}
                className="input-field w-auto"
              >
                <option value="">All families</option>
                {families.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="input-label">Component role</label>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="input-field w-auto"
              >
                <option value="">All roles</option>
                <option value={UNMAPPED_FILTER}>Not mapped</option>
                {roles.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="input-label">Contribution</label>
              <select
                value={contributionFilter}
                onChange={(e) => setContributionFilter(e.target.value)}
                className="input-field w-auto"
              >
                <option value="">All contributions</option>
                <option value={UNSET_CONTRIBUTION_FILTER}>Not set</option>
                {contributionModes.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600 pb-2">
              <input
                type="checkbox"
                checked={onlyReview}
                onChange={(e) => setOnlyReview(e.target.checked)}
              />
              Needs review only
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600 pb-2">
              <input
                type="checkbox"
                checked={onlyProvisional}
                onChange={(e) => setOnlyProvisional(e.target.checked)}
              />
              Provisional durations
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600 pb-2">
              <input
                type="checkbox"
                checked={onlyIncomplete}
                onChange={(e) => setOnlyIncomplete(e.target.checked)}
              />
              Incomplete configuration
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600 pb-2">
              <input
                type="checkbox"
                checked={includeRetired}
                onChange={(e) => setIncludeRetired(e.target.checked)}
              />
              Include retired services
            </label>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="No services match"
              description="No services match the current search and filters."
            />
          ) : (
            <div className="table-container">
              <div className="px-5 py-4 border-b border-slate-100">
                <h2 className="text-sm font-semibold text-slate-900">
                  Services ({filtered.length} of {rows.length})
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  A mapping is never edited or deleted. Changing one closes the current mapping and
                  opens a new one, so a job measured last month can still be explained by the
                  mapping that was in force then.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1240px] text-sm">
                  <thead className="table-header">
                    <tr>
                      <th>Service</th>
                      <th>Contribution</th>
                      <th>Component role</th>
                      <th>Standard minutes</th>
                      <th>Shares component with</th>
                      <th>In force since</th>
                      <th className="text-center">Used by jobs</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => {
                      const review = row.needsReview && row.serviceIsActive;
                      // Incomplete outranks the rest: it is the only one of the three
                      // that is producing a wrong number rather than a missing one.
                      const tint = row.incompleteConfiguration
                        ? 'bg-red-50/60'
                        : review || row.provisionalDuration
                          ? 'bg-amber-50/60'
                          : '';
                      return (
                        <tr key={row.serviceTypeId} className={`table-row ${tint}`}>
                          <td>
                            <span className="font-mono text-xs text-slate-600">{row.code}</span>
                            <span className="block font-medium text-slate-900">{row.name}</span>
                            <span className="block text-[11px] text-slate-400">
                              {row.family}
                              {!row.serviceIsActive && ' · retired'}
                            </span>
                            {row.isSupersededCode && (
                              <span
                                className="badge bg-slate-100 text-slate-600 text-[10px] mt-1"
                                title="Kept out of new bookings. Job lines already recorded against it stay valid and still resolve."
                              >
                                out of use
                              </span>
                            )}
                          </td>
                          <td>
                            {row.contributionMode ? (
                              <>
                                <span
                                  className={`badge text-[11px] ${CONTRIBUTION_BADGE[row.contributionMode] ?? 'bg-slate-100 text-slate-600'}`}
                                >
                                  {contributionLabels.get(row.contributionMode) ??
                                    row.contributionMode}
                                </span>
                                {row.allowanceBasis && (
                                  <span className="block text-[10px] text-slate-500 mt-1">
                                    {ALLOWANCE_BASIS_LABELS.get(row.allowanceBasis) ??
                                      row.allowanceBasis}
                                  </span>
                                )}
                                {row.contributionMode === 'CONDITIONAL' && (
                                  <span
                                    className={`block text-[10px] mt-0.5 ${
                                      row.requiredQualifier && row.requiredQualifier !== 'NONE'
                                        ? 'text-slate-500'
                                        : 'text-red-700'
                                    }`}
                                  >
                                    {row.requiredQualifier && row.requiredQualifier !== 'NONE'
                                      ? `needs ${QUALIFIER_LABELS.get(row.requiredQualifier) ?? row.requiredQualifier}`
                                      : 'no qualifier set — never counts'}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-slate-400">--</span>
                            )}
                          </td>
                          <td>
                            {row.componentRole ? (
                              <>
                                <span
                                  className={`badge text-[11px] ${ROLE_BADGE[row.componentRole] ?? 'bg-slate-100 text-slate-600'}`}
                                >
                                  {row.componentRoleLabel ?? row.componentRole}
                                </span>
                                {row.requiresAxleQualifier && (
                                  <span
                                    className="block text-[10px] text-slate-500 mt-1"
                                    title="An order line must state the axle before this service can satisfy the component."
                                  >
                                    axle qualifier required
                                  </span>
                                )}
                                {row.notes && (
                                  <span className="block text-[11px] text-slate-400 mt-0.5 max-w-xs">
                                    {row.notes}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="badge bg-amber-100 text-amber-800 text-[10px]">
                                Not mapped
                              </span>
                            )}
                            {review && (
                              <span className="block text-[10px] text-amber-700 mt-1">
                                jobs fall to Custom (not benchmarked)
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap">
                            {row.componentRole ? (
                              <>
                                <span className="block text-[11px] text-slate-500">
                                  {durationSourceLabels.get(row.durationSource ?? '') ??
                                    row.durationSource ??
                                    '--'}
                                </span>
                                <span className="block text-xs text-slate-700 tabular-nums mt-0.5">
                                  Sedan {minutesLabel(row.sedanMinutes, row.durationSource)}
                                </span>
                                <span className="block text-xs text-slate-700 tabular-nums">
                                  SUV {minutesLabel(row.suvMinutes, row.durationSource)}
                                </span>
                                {row.durationSource === 'SERVICE_CATALOG_DURATION' && (
                                  <span className="block text-[10px] text-slate-400 mt-0.5">
                                    {row.catalogueMinutes
                                      ? `from the service catalogue (${row.catalogueMinutes} min)`
                                      : 'no duration in the service catalogue'}
                                  </span>
                                )}
                                {row.provisionalDuration && (
                                  <span
                                    className="badge bg-amber-100 text-amber-800 text-[10px] mt-1"
                                    title="A seeded stand-in, not a figure management has agreed. Technicians are measured against it until it is replaced."
                                  >
                                    provisional
                                  </span>
                                )}
                                {row.incompleteConfiguration && (
                                  <span className="block text-[10px] text-red-700 mt-1">
                                    cannot produce a standard
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-slate-400">--</span>
                            )}
                          </td>
                          <td>
                            {row.aliasOf.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {row.aliasOf.map((code) => (
                                  <span
                                    key={code}
                                    className="font-mono text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5"
                                  >
                                    {code}
                                  </span>
                                ))}
                                <span className="block w-full text-[10px] text-slate-400 mt-0.5">
                                  same component — counted once
                                </span>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">--</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap">
                            {row.effectiveFrom ? (
                              <>
                                <span className="text-xs text-slate-700">
                                  {new Date(row.effectiveFrom).toLocaleDateString()}
                                </span>
                                <span className="block text-[11px] text-slate-400">
                                  {actorLabel(row.updatedByName, row.updatedByUserId, actorNames)}
                                </span>
                              </>
                            ) : (
                              <span className="text-xs text-slate-400">--</span>
                            )}
                          </td>
                          <td className="text-center text-xs tabular-nums text-slate-600">
                            {row.timesUsed}
                            {row.timesUsed > 0 && (
                              <span className="block text-[10px] text-slate-400">
                                deactivate only
                              </span>
                            )}
                          </td>
                          <td className="text-right whitespace-nowrap">
                            <div className="flex gap-2 justify-end">
                              {row.provisionalDuration ? (
                                <button
                                  onClick={() => openEdit(row)}
                                  className="text-xs text-amber-700 hover:underline font-medium"
                                >
                                  Confirm duration
                                </button>
                              ) : (
                                <button
                                  onClick={() => openEdit(row)}
                                  className="text-xs text-blue-600 hover:underline font-medium"
                                >
                                  {row.componentRole ? 'Change' : 'Set mapping'}
                                </button>
                              )}
                              {row.mappingId && (
                                <button
                                  onClick={() => {
                                    setDeactivating(row);
                                    setDeactivateReason('');
                                    deactivateMutation.reset();
                                  }}
                                  className="text-xs text-slate-500 hover:underline"
                                >
                                  Deactivate
                                </button>
                              )}
                              <button
                                onClick={() => setHistoryFor(row)}
                                className="text-xs text-slate-500 hover:underline"
                              >
                                History
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="card w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto">
            <h3 className="text-sm font-semibold text-slate-900">
              {editing.componentRole ? 'Change mapping' : 'Set mapping'} — {editing.code}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">{editing.name}</p>

            {editing.componentRole && (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                Currently {editing.componentRoleLabel ?? editing.componentRole}
                {editing.contributionMode &&
                  `, ${(contributionLabels.get(editing.contributionMode) ?? editing.contributionMode).toLowerCase()}`}
                {editing.requiresAxleQualifier && ', axle qualifier required'}
                {editing.effectiveFrom &&
                  `, in force since ${new Date(editing.effectiveFrom).toLocaleDateString()}`}
                .
                <span className="block mt-1">
                  Saving supersedes this mapping rather than editing it. The {editing.timesUsed} job
                  line{editing.timesUsed === 1 ? '' : 's'} already recorded against this service stay
                  measured against the mapping that was in force at the time.
                </span>
              </div>
            )}

            {editing.provisionalDuration && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                The current duration is provisional — a seeded stand-in, not a figure management
                has agreed, and technicians are being measured against it today. Replace it: choose
                a fixed configured duration and enter the confirmed minutes below, or point the
                service at the catalogue duration. Saving a real figure clears the mark.
              </div>
            )}

            {editing.incompleteConfiguration && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
                This mapping cannot produce a standard as configured, so jobs carrying{' '}
                {editing.code} are measured against nothing. Give the duration source a figure it
                can read, or give a conditional service the qualifier it tests.
              </div>
            )}

            <div className="space-y-3 mt-4">
              <div>
                <label className="input-label">Contribution</label>
                <select
                  value={editContributionMode}
                  onChange={(e) => {
                    const mode = e.target.value;
                    setEditContributionMode(mode);
                    // Only a conditional service tests a qualifier; carrying a stale one
                    // forward would leave a rule on a service that never applies it.
                    if (mode !== 'CONDITIONAL') setEditRequiredQualifier('NONE');
                  }}
                  className="input-field"
                >
                  <option value="">Select how this service contributes...</option>
                  {contributionModes.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                {editContributionMode && CONTRIBUTION_HINT[editContributionMode] && (
                  <p className="text-[11px] text-slate-500 mt-1">
                    {CONTRIBUTION_HINT[editContributionMode]}
                  </p>
                )}
              </div>

              {editContributionMode === 'CONDITIONAL' && (
                <div>
                  <label className="input-label">Required qualifier</label>
                  <select
                    value={editRequiredQualifier}
                    onChange={(e) => setEditRequiredQualifier(e.target.value)}
                    className="input-field"
                  >
                    {REQUIRED_QUALIFIERS.map((q) => (
                      <option key={q.value} value={q.value}>{q.label}</option>
                    ))}
                  </select>
                  <p
                    className={`text-[11px] mt-1 ${editRequiredQualifier === 'NONE' ? 'text-red-700' : 'text-slate-500'}`}
                  >
                    {editRequiredQualifier === 'NONE'
                      ? 'A conditional service with no qualifier has nothing to test, so it never counts. Choose one.'
                      : 'The work-order line must carry this qualifier before the service contributes anything.'}
                  </p>
                </div>
              )}

              <div>
                <label className="input-label">Component role</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value)}
                  className="input-field"
                >
                  <option value="">Select a role...</option>
                  {roles.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                {editRole && ROLE_HINT[editRole] && (
                  <p className="text-[11px] text-slate-500 mt-1">{ROLE_HINT[editRole]}</p>
                )}
              </div>

              <div>
                <label className="input-label">Where the minutes come from</label>
                <select
                  value={editDurationSource}
                  onChange={(e) => {
                    const source = e.target.value;
                    setEditDurationSource(source);
                    // The inputs below are the only place these figures are entered, so
                    // leaving typed values behind a hidden field would save them unseen.
                    if (source !== 'FIXED_CONFIGURED_DURATION') {
                      setEditSedanMinutes('');
                      setEditSuvMinutes('');
                    }
                  }}
                  className="input-field"
                >
                  <option value="">Select a duration source...</option>
                  {durationSources.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
                {editDurationSource && DURATION_SOURCE_HINT[editDurationSource] && (
                  <p className="text-[11px] text-slate-500 mt-1">
                    {DURATION_SOURCE_HINT[editDurationSource]}
                  </p>
                )}
                {editDurationSource === 'SERVICE_CATALOG_DURATION' &&
                  (editing.catalogueMinutes ? (
                    <p className="text-[11px] text-slate-500 mt-1">
                      The catalogue currently gives {editing.catalogueMinutes} minutes for{' '}
                      {editing.code}.
                    </p>
                  ) : (
                    <p className="text-[11px] text-red-700 mt-1">
                      {editing.code} has no duration in the service catalogue, so this mapping
                      would produce no standard. Set the catalogue duration first, or use a fixed
                      configured duration here.
                    </p>
                  ))}
              </div>

              {editDurationSource === 'FIXED_CONFIGURED_DURATION' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="input-label">Sedan minutes</label>
                    <input
                      type="number"
                      min={1}
                      value={editSedanMinutes}
                      onChange={(e) => {
                        setEditSedanMinutes(e.target.value);
                        // Supplying a real figure is the act that confirms a stand-in.
                        setEditProvisional(false);
                      }}
                      placeholder={editSeeds.sedan ? editSeeds.sedan : 'unchanged'}
                      className="input-field"
                    />
                  </div>
                  <div>
                    <label className="input-label">SUV minutes</label>
                    <input
                      type="number"
                      min={1}
                      value={editSuvMinutes}
                      onChange={(e) => setEditSuvMinutes(e.target.value)}
                      placeholder="same as sedan"
                      className="input-field"
                    />
                  </div>
                  <p className="col-span-2 text-[11px] text-slate-400">
                    Leave a box blank to keep the figure already stored. Set SUV minutes only
                    where management has approved a class split; otherwise the sedan figure applies
                    to both.
                  </p>
                </div>
              )}

              <div>
                <label className="input-label">Counted</label>
                <select
                  value={editAllowanceBasis}
                  onChange={(e) => setEditAllowanceBasis(e.target.value)}
                  className="input-field"
                >
                  {ALLOWANCE_BASES.map((b) => (
                    <option key={b.value} value={b.value}>{b.label}</option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  How often the allowance is granted on one job — once whatever the order says,
                  once per service line, or once per unit worked on.
                </p>
              </div>

              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={editProvisional}
                  onChange={(e) => setEditProvisional(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Duration is provisional
                  <span className="block text-[11px] text-slate-400">
                    Marks the figure as a stand-in awaiting management confirmation. It is flagged
                    on this screen until someone replaces it. Entering a confirmed figure above
                    clears it.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={editSuperseded}
                  onChange={(e) => setEditSuperseded(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Keep this code out of new bookings
                  <span className="block text-[11px] text-slate-400">
                    The code is retired from new work but stays mapped, so job lines already
                    recorded against it still resolve and stay explicable.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={editAxle}
                  onChange={(e) => setEditAxle(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Require an axle qualifier
                  <span className="block text-[11px] text-slate-400">
                    The order line must state the axle before this service satisfies its component.
                    Set it for brake work, where the service code alone does not say front or rear.
                  </span>
                </span>
              </label>

              <div>
                <label className="input-label">Why this mapping</label>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={2}
                  maxLength={1000}
                  placeholder="Recorded against the change and shown here afterwards..."
                  className="input-field"
                />
              </div>

              <div>
                <label className="input-label">Takes effect</label>
                <input
                  type="datetime-local"
                  value={editEffectiveFrom}
                  onChange={(e) => setEditEffectiveFrom(e.target.value)}
                  className="input-field"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Leave blank for immediately. A mapping cannot be backdated — that would change
                  what jobs already under way are measured against.
                </p>
              </div>
            </div>

            {editIsBackdated && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                That date is in the past. Choose now or a future date.
              </div>
            )}

            {editIsFlagOnly && !editIsBackdated && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Only the provisional or out-of-use marks have changed. Those ride along with a new
                mapping rather than creating one, so nothing will be recorded. Change the
                contribution, the duration source or the minutes as well.
              </div>
            )}

            {editIsNoOp && !editIsFlagOnly && !editIsBackdated && (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                The role, contribution and duration are unchanged, so nothing will be superseded.
                Notes on their own do not create a new mapping.
              </div>
            )}

            {saveMutation.isError && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {errorMessage(saveMutation.error, 'Could not save the mapping.')}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={closeEdit} className="btn-secondary py-1.5 px-3 text-xs">
                Cancel
              </button>
              <button
                onClick={submitEdit}
                disabled={
                  !editRole ||
                  !editContributionMode ||
                  !editDurationSource ||
                  editIsBackdated ||
                  saveMutation.isPending
                }
                className="btn-primary py-1.5 px-3 text-xs"
              >
                {saveMutation.isPending ? 'Saving...' : 'Save mapping'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deactivating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="card w-full max-w-md p-5">
            <h3 className="text-sm font-semibold text-slate-900">
              Deactivate mapping — {deactivating.code}
            </h3>
            <p className="text-xs text-slate-600 mt-2">
              The mapping stops applying to new jobs. It is not deleted: the {deactivating.timesUsed}{' '}
              job line{deactivating.timesUsed === 1 ? '' : 's'} already recorded against this service
              can still be explained by it.
            </p>
            <p className="text-xs text-amber-700 mt-2">
              Until a new mapping is set, {deactivating.code} is unmapped and any job containing it
              is measured as Custom (not benchmarked).
            </p>

            <div className="mt-4">
              <label className="input-label">Why it no longer applies</label>
              <textarea
                value={deactivateReason}
                onChange={(e) => setDeactivateReason(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="Recorded in the audit log..."
                className="input-field"
              />
            </div>

            {deactivateMutation.isError && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {errorMessage(deactivateMutation.error, 'Could not deactivate the mapping.')}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setDeactivating(null)}
                className="btn-secondary py-1.5 px-3 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  deactivating.mappingId &&
                  deactivateMutation.mutate({
                    mappingId: deactivating.mappingId,
                    reason: deactivateReason.trim(),
                  })
                }
                disabled={deactivateMutation.isPending}
                className="btn-primary py-1.5 px-3 text-xs"
              >
                {deactivateMutation.isPending ? 'Deactivating...' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {historyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="card w-full max-w-2xl p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Mapping history — {historyFor.code}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{historyFor.name}</p>
              </div>
              <button
                onClick={() => setHistoryFor(null)}
                className="btn-secondary py-1.5 px-3 text-xs shrink-0"
              >
                Close
              </button>
            </div>

            {historyQuery.isLoading && <LoadingState message="Loading history..." />}

            {historyQuery.isError && (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {errorMessage(historyQuery.error, 'Could not load the mapping history.')}
              </div>
            )}

            {historyQuery.data && historyQuery.data.length === 0 && (
              <p className="text-xs text-slate-500 mt-4">
                This service has never been mapped.
              </p>
            )}

            {historyQuery.data && historyQuery.data.length > 0 && (
              <table className="w-full text-sm mt-4">
                <thead className="table-header">
                  <tr>
                    <th>Role</th>
                    <th>In force</th>
                    <th>Changed by</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {historyQuery.data.map((h) => (
                    <tr key={h.id} className="table-row">
                      <td>
                        <span
                          className={`badge text-[11px] ${ROLE_BADGE[h.componentRole] ?? 'bg-slate-100 text-slate-600'}`}
                        >
                          {roleLabels.get(h.componentRole) ?? h.componentRole}
                        </span>
                        {h.requiresAxleQualifier && (
                          <span className="block text-[10px] text-slate-500 mt-1">
                            axle qualifier required
                          </span>
                        )}
                        {h.notes && (
                          <span className="block text-[11px] text-slate-400 mt-0.5">{h.notes}</span>
                        )}
                      </td>
                      <td className="text-xs text-slate-600 whitespace-nowrap">
                        {new Date(h.effectiveFrom).toLocaleString()}
                        <span className="block text-[11px] text-slate-400">
                          {h.effectiveTo
                            ? `until ${new Date(h.effectiveTo).toLocaleString()}`
                            : h.isActive
                              ? 'current'
                              : 'closed'}
                        </span>
                      </td>
                      <td className="text-xs text-slate-500">
                        {actorLabel(h.updatedByName, h.updatedByUserId, actorNames)}
                      </td>
                      <td className="text-right">
                        {!h.isActive && (
                          <button
                            onClick={() => {
                              const target = historyFor;
                              setHistoryFor(null);
                              openEdit(target, {
                                role: h.componentRole,
                                axle: h.requiresAxleQualifier,
                              });
                            }}
                            className="text-xs text-blue-600 hover:underline font-medium"
                          >
                            Reinstate
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <p className="text-[11px] text-slate-400 mt-4">
              Nothing here can be deleted. Reinstating an old mapping opens a new one from now
              onwards; it never reopens the original row, because jobs measured between then and
              now were rated against what stood at the time. History records the component role
              only, so a reinstated mapping keeps the contribution and duration currently in force
              — check them before saving.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
