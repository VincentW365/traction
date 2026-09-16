'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { PageHeader } from '../../../../../components/ui/page-header';
import { LoadingState } from '../../../../../components/ui/loading-state';

/**
 * CR-2026-108 Stage 4B — Catalogue Readiness.
 *
 * Decision support, not an action. Nothing on this page writes: it shows which
 * services are safe, understandable and operationally suitable for customer
 * self-service, with the reason, so a person decides. Enabling happens in Stage 4C
 * through the normal catalogue editor, deliberately.
 */

type Readiness = 'READY_FOR_REVIEW' | 'NEEDS_CONFIGURATION' | 'NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE';

interface Evidence {
  source: 'LIVE_PLATFORM' | 'HISTORICAL_IMPORT';
  sampleCount: number;
  medianMinutes: number | null;
  p75Minutes: number | null;
  p90Minutes: number | null;
  insufficient: boolean;
}
interface Flag { code: string; severity: 'BLOCKER' | 'WARNING' | 'INFO'; message: string }
interface Row {
  code: string; name: string; customerFacingName: string | null; effectiveCustomerName: string;
  family: string; isExternal: boolean; bookableOnline: boolean; appointmentOnly: boolean;
  baseDurationMinutes: number | null; bookingBufferMinutes: number;
  effectivePlannedMinutes: number; usesFallbackDuration: boolean; schedulingOccupancyMinutes: number;
  requiredSkillCode: string | null; requiredBayType: string | null;
  canUseOverflow: boolean; canUseLightSlot: boolean;
  catalogueRole: string; readiness: Readiness; reasons: string[]; flags: Flag[];
  currentlyOfferedToCustomers: boolean; proposedCustomerFacingName: string | null;
  evidence: Evidence[];
}
interface Report {
  generatedAt: string; enforcementEnabled: boolean; durationSource: string; defaultDurationMinutes: number;
  totals: Record<string, number>;
  evidenceSummary: { livePlatformOrders: number; historicalImportOrders: number; historicalImportLinkedToServices: number; note: string };
  services: Row[];
  proposedStartingSet: Array<{ code: string; proposedCustomerFacingName: string; durationMinutes: number; proposedBufferMinutes: number; requiredBayType: string | null; requiredSkillCode: string | null; reason: string }>;
  deliberatelyExcluded: Array<{ code: string; name: string; reason: string }>;
}

const READINESS_META: Record<Readiness, { label: string; cls: string }> = {
  READY_FOR_REVIEW: { label: 'Ready for review', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  NEEDS_CONFIGURATION: { label: 'Needs configuration', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE: { label: 'Not suitable', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
};
const SEVERITY_CLS: Record<Flag['severity'], string> = {
  BLOCKER: 'text-red-700',
  WARNING: 'text-amber-800',
  INFO: 'text-slate-500',
};

export default function CatalogueReadinessPage() {
  const [filter, setFilter] = useState<'ALL' | Readiness>('ALL');
  const [onlyOffered, setOnlyOffered] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const q = useQuery<Report>({ queryKey: ['catalogue-readiness'], queryFn: () => api.get('/service-types/readiness') });
  const rows = useMemo(() => {
    const all = q.data?.services ?? [];
    return all
      .filter((r) => filter === 'ALL' || r.readiness === filter)
      .filter((r) => !onlyOffered || r.currentlyOfferedToCustomers);
  }, [q.data, filter, onlyOffered]);

  if (q.isLoading) return <LoadingState message="Auditing the service catalogue…" />;
  if (q.isError || !q.data) return <p className="text-sm text-red-700">{(q.error as Error)?.message ?? 'Could not run the audit.'}</p>;
  const r = q.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Catalogue Readiness"
        subtitle="Which services are suitable for customer self-service booking. Read-only — nothing here changes the catalogue."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Setup' }, { label: 'Services', href: '/admin/service-catalogue' }, { label: 'Readiness' }]}
      />

      {/* --- headline --- */}
      <div className="card">
        <div className="card-body grid gap-3 sm:grid-cols-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Offered to customers today</p>
            <p className="text-2xl font-bold text-slate-900">{r.totals.currentlyOffered}<span className="text-sm font-normal text-slate-500"> of {r.totals.activeServices} active</span></p>
            <p className="text-xs text-slate-600">
              Enforcement {r.enforcementEnabled ? 'ON' : 'OFF'} · {r.totals.bookableOnline} marked bookable online
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Readiness</p>
            <p className="text-sm text-slate-800">
              <strong className="text-emerald-700">{r.totals.readyForReview}</strong> ready ·{' '}
              <strong className="text-amber-800">{r.totals.needsConfiguration}</strong> need configuration ·{' '}
              <strong className="text-slate-600">{r.totals.notSuitable}</strong> not suitable
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Planning duration</p>
            <p className="text-sm text-slate-800">
              Source <strong>{r.durationSource}</strong> · default <strong>{r.defaultDurationMinutes}m</strong>
            </p>
          </div>
        </div>
      </div>

      {/* --- evidence quality: stated once, loudly --- */}
      <div className="card border-amber-200">
        <div className="card-body">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Evidence quality</p>
          <p className="mt-1 text-sm text-slate-800">{r.evidenceSummary.note}</p>
          <p className="mt-2 text-xs text-slate-600">
            Live-platform orders: <strong>{r.evidenceSummary.livePlatformOrders}</strong> ·
            Historical-import records: <strong>{r.evidenceSummary.historicalImportOrders}</strong> ·
            of which carry service lines: <strong>{r.evidenceSummary.historicalImportLinkedToServices}</strong>
          </p>
        </div>
      </div>

      {/* --- filters --- */}
      <div className="card">
        <div className="card-body flex flex-wrap items-center gap-3 text-xs">
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as 'ALL' | Readiness)}>
            <option value="ALL">All readiness states</option>
            <option value="READY_FOR_REVIEW">Ready for review</option>
            <option value="NEEDS_CONFIGURATION">Needs configuration</option>
            <option value="NOT_SUITABLE_FOR_DIRECT_SELF_SERVICE">Not suitable</option>
          </select>
          <label className="flex items-center gap-2 text-slate-700">
            <input type="checkbox" checked={onlyOffered} onChange={(e) => setOnlyOffered(e.target.checked)} />
            Only what customers can book today
          </label>
          <span className="text-slate-500">{rows.length} shown</span>
        </div>
      </div>

      {/* --- the audit --- */}
      <div className="card">
        <div className="card-body overflow-x-auto">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>Service</th><th>Shown to customer</th><th>Readiness</th>
                <th>Duration</th><th>Occupies</th><th>Bay / Skill</th><th>Role</th><th>Today</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <>
                  <tr key={s.code} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === s.code ? null : s.code)}>
                    <td>
                      <div className="font-mono text-[10px] text-slate-500">{s.code}</div>
                      <div className="font-medium text-slate-900">{s.name}</div>
                    </td>
                    <td className="text-slate-700">
                      {s.customerFacingName ?? <span className="text-slate-400">{s.effectiveCustomerName} (internal name)</span>}
                    </td>
                    <td>
                      <span className={`badge border text-[10px] ${READINESS_META[s.readiness].cls}`}>{READINESS_META[s.readiness].label}</span>
                      {s.flags.some((f) => f.severity === 'BLOCKER') && <span className="ml-1 text-[10px] text-red-700">!</span>}
                    </td>
                    <td className="text-center">
                      {s.baseDurationMinutes ? `${s.baseDurationMinutes}m` : <span className="text-red-700">none</span>}
                      {s.usesFallbackDuration && <div className="text-[10px] text-slate-500">plans {s.effectivePlannedMinutes}m</div>}
                    </td>
                    <td className="text-center">{s.schedulingOccupancyMinutes}m</td>
                    <td className="text-[10px] text-slate-500">{s.requiredBayType ?? '--'} / {s.requiredSkillCode ?? '--'}</td>
                    <td className="text-[10px] text-slate-500">{s.catalogueRole.replace(/_/g, ' ').toLowerCase()}</td>
                    <td>{s.currentlyOfferedToCustomers ? <span className="badge bg-blue-50 text-blue-700 text-[10px]">Offered</span> : '--'}</td>
                  </tr>
                  {open === s.code && (
                    <tr key={`${s.code}-detail`}>
                      <td colSpan={8} className="bg-slate-50 p-3">
                        <p className="text-xs font-semibold text-slate-800">Why</p>
                        <ul className="mb-2 list-disc pl-5 text-xs text-slate-700">
                          {s.reasons.map((x, i) => <li key={i}>{x}</li>)}
                        </ul>
                        {s.flags.length > 0 && (
                          <>
                            <p className="text-xs font-semibold text-slate-800">Flags</p>
                            <ul className="mb-2 list-disc pl-5 text-xs">
                              {s.flags.map((f) => (
                                <li key={f.code} className={SEVERITY_CLS[f.severity]}>
                                  <span className="font-mono text-[10px]">{f.code}</span> — {f.message}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <p className="text-xs font-semibold text-slate-800">Timing evidence</p>
                        <ul className="list-disc pl-5 text-xs text-slate-700">
                          {s.evidence.map((e) => (
                            <li key={e.source}>
                              {e.source === 'LIVE_PLATFORM' ? 'Live platform' : 'Historical import'}: n={e.sampleCount}
                              {e.insufficient
                                ? ' — too small to draw a conclusion from'
                                : ` · median ${e.medianMinutes}m · p75 ${e.p75Minutes}m · p90 ${e.p90Minutes}m`}
                            </li>
                          ))}
                        </ul>
                        {s.proposedCustomerFacingName && (
                          <p className="mt-2 text-xs text-slate-700">
                            Suggested customer-facing name: <strong>{s.proposedCustomerFacingName}</strong> (not applied)
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- proposal --- */}
      <div className="card border-emerald-200">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Proposed starting set — {r.proposedStartingSet.length} services</h2>
        </div>
        <div className="card-body">
          <p className="mb-2 text-xs text-slate-600">
            A recommendation for review. Nothing here is enabled — Stage 4C applies whatever management approves,
            through the normal catalogue editor.
          </p>
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr><th>Service</th><th>Customer name</th><th>Duration</th><th>Buffer</th><th>Bay / Skill</th></tr>
              </thead>
              <tbody>
                {r.proposedStartingSet.map((p) => (
                  <tr key={p.code}>
                    <td className="font-mono text-[10px]">{p.code}</td>
                    <td className="text-slate-800">{p.proposedCustomerFacingName}</td>
                    <td className="text-center">{p.durationMinutes}m</td>
                    <td className="text-center">{p.proposedBufferMinutes}m</td>
                    <td className="text-[10px] text-slate-500">{p.requiredBayType ?? '--'} / {p.requiredSkillCode ?? '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs font-semibold text-slate-800">Deliberately excluded ({r.deliberatelyExcluded.length})</p>
          <ul className="list-disc pl-5 text-xs text-slate-600">
            {r.deliberatelyExcluded.map((e) => <li key={e.code}><span className="font-mono text-[10px]">{e.code}</span> {e.name} — {e.reason}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}
