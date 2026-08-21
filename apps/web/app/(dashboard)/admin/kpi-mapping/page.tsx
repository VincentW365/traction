'use client';

import { useMemo, useState } from 'react';
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
 */

const ALLOWED_ROLES = ['ADMIN'];

const UNMAPPED_FILTER = '__UNMAPPED__';

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
  effectiveFrom: string | null;
  notes: string | null;
  updatedByUserId: string | null;
  aliasOf: string[];
  timesUsed: number;
  needsReview: boolean;
}

interface MappingsResponse {
  rows: MappingRow[];
  roles: RoleOption[];
  unmappedCount: number;
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
}

interface StaffMember {
  id: string;
  fullName: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function KpiMappingPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [familyFilter, setFamilyFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [onlyReview, setOnlyReview] = useState(false);
  const [includeRetired, setIncludeRetired] = useState(false);

  const [editing, setEditing] = useState<MappingRow | null>(null);
  const [editRole, setEditRole] = useState('');
  const [editAxle, setEditAxle] = useState(false);
  const [editNotes, setEditNotes] = useState('');
  const [editEffectiveFrom, setEditEffectiveFrom] = useState('');

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

  const roleLabels = useMemo(
    () => new Map(roles.map((r) => [r.value, r.label])),
    [roles],
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
      if (familyFilter && r.family !== familyFilter) return false;
      if (roleFilter === UNMAPPED_FILTER && r.componentRole) return false;
      if (roleFilter && roleFilter !== UNMAPPED_FILTER && r.componentRole !== roleFilter) return false;
      if (!term) return true;
      return (
        r.code.toLowerCase().includes(term) ||
        r.name.toLowerCase().includes(term) ||
        r.family.toLowerCase().includes(term)
      );
    });
  }, [rows, search, familyFilter, roleFilter, onlyReview, includeRetired]);

  function openEdit(row: MappingRow, preset?: { role: string; axle: boolean }) {
    setEditing(row);
    setEditRole(preset?.role ?? row.componentRole ?? '');
    setEditAxle(preset?.axle ?? row.requiresAxleQualifier);
    setEditNotes('');
    setEditEffectiveFrom('');
    saveMutation.reset();
  }

  function closeEdit() {
    setEditing(null);
    setEditRole('');
    setEditAxle(false);
    setEditNotes('');
    setEditEffectiveFrom('');
  }

  const editIsBackdated =
    editEffectiveFrom !== '' &&
    !Number.isNaN(new Date(editEffectiveFrom).getTime()) &&
    new Date(editEffectiveFrom).getTime() < Date.now() - BACKDATE_TOLERANCE_MS;

  // The server treats an identical role + axle as a no-op rather than a supersede, so
  // notes typed on their own would silently go nowhere.
  const editIsNoOp =
    !!editing &&
    editing.componentRole === editRole &&
    editing.requiresAxleQualifier === editAxle;

  function submitEdit() {
    if (!editing || !editRole || editIsBackdated) return;
    const effectiveFrom = editEffectiveFrom ? new Date(editEffectiveFrom) : null;
    saveMutation.mutate({
      serviceTypeId: editing.serviceTypeId,
      componentRole: editRole,
      requiresAxleQualifier: editAxle,
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
            <div className="card border-amber-200 bg-amber-50 p-4 mb-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-amber-900">
                    {data.unmappedCount} active service{data.unmappedCount === 1 ? '' : 's'} not mapped
                  </h2>
                  <p className="text-xs text-amber-800 mt-1 max-w-2xl">
                    A work order containing an unmapped service cannot be matched to an approved
                    package, so the whole job is measured as Custom (not benchmarked) and drops out
                    of technician comparison. Map every service you expect to appear on a job.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setOnlyReview(true);
                    setRoleFilter('');
                  }}
                  className="btn-secondary py-1.5 px-3 text-xs shrink-0"
                >
                  Show these
                </button>
              </div>
            </div>
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
                <table className="w-full min-w-[960px] text-sm">
                  <thead className="table-header">
                    <tr>
                      <th>Service</th>
                      <th>Component role</th>
                      <th>Shares component with</th>
                      <th>In force since</th>
                      <th className="text-center">Used by jobs</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => {
                      const review = row.needsReview && row.serviceIsActive;
                      return (
                        <tr
                          key={row.serviceTypeId}
                          className={`table-row ${review ? 'bg-amber-50/60' : ''}`}
                        >
                          <td>
                            <span className="font-mono text-xs text-slate-600">{row.code}</span>
                            <span className="block font-medium text-slate-900">{row.name}</span>
                            <span className="block text-[11px] text-slate-400">
                              {row.family}
                              {!row.serviceIsActive && ' · retired'}
                            </span>
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
                                  {row.updatedByUserId
                                    ? (actorNames.get(row.updatedByUserId) ?? 'unknown user')
                                    : 'seeded'}
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
                              <button
                                onClick={() => openEdit(row)}
                                className="text-xs text-blue-600 hover:underline font-medium"
                              >
                                {row.componentRole ? 'Change' : 'Set mapping'}
                              </button>
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

            <div className="space-y-3 mt-4">
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

            {editIsNoOp && !editIsBackdated && (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                The role and axle qualifier are unchanged, so nothing will be superseded. Notes on
                their own do not create a new mapping.
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
                disabled={!editRole || editIsBackdated || saveMutation.isPending}
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
                        {h.updatedByUserId
                          ? (actorNames.get(h.updatedByUserId) ?? 'unknown user')
                          : 'seeded'}
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
              now were rated against what stood at the time.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
