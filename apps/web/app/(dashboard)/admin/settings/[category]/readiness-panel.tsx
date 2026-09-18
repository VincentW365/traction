'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { RelatedLink, SettingStatus } from '../../../../../components/settings/primitives';

/**
 * CR-2026-109 §10 — resource readiness, where the decision is made.
 *
 * Whether resource-aware scheduling can be switched on is a question about bays,
 * and the answer lives on a different screen. Making the manager go and find it,
 * interpret it and come back is how a switch gets flipped on a guess. So the
 * answer is brought here, with the link to fix it.
 *
 * Read-only. Nothing on this panel changes configuration.
 */

interface Readiness {
  production: {
    ready: boolean;
    blockers: Array<{ label: string; detail: string }>;
    warnings: Array<{ label: string; detail: string }>;
  };
  publicServices: Array<{
    code: string;
    name: string;
    requiredCapability: string | null;
    verifiedEligiblePositions: number;
    status: 'READY' | 'INCOMPLETE';
    singlePointOfFailure: boolean;
  }>;
  current: {
    verifiedActivePositions: number;
    provisionalIdentities: number;
    optionalUnverifiedResources: number;
  };
}

const CAPABILITY_LABEL: Record<string, string> = {
  ALIGNMENT: 'Wheel alignment',
  DIAGNOSTIC: 'Diagnostics',
  GENERAL: 'General repair',
  INSPECTION: 'Inspection',
  LUBE: 'Oil & lube',
  TIRE: 'Tires',
  CLEANING: 'Cleaning',
};

export function ResourceReadinessPanel({ siteId }: { siteId: string }) {
  const q = useQuery<Readiness>({
    queryKey: ['resource-readiness', siteId],
    queryFn: () => api.get(`/resources/readiness?siteId=${siteId}`),
    enabled: !!siteId,
    retry: false,
  });

  if (q.isError) {
    return (
      <section className="surface p-5">
        <p className="text-sm text-slate-500">
          Resource readiness could not be loaded. You can still change settings on this page.
        </p>
      </section>
    );
  }
  if (!q.data) return null;
  const r = q.data;
  const ready = r.production.ready;
  const readyCount = r.publicServices.filter((s) => s.status === 'READY').length;

  return (
    <section className="surface overflow-hidden">
      <div className="surface-header flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Resource-Aware Scheduling</h2>
          <p className="text-sm text-slate-500 mt-0.5 leading-relaxed max-w-2xl">
            Works availability out from the bays you have configured instead of one fixed limit. It is running
            alongside today for comparison and decides nothing customers see.
          </p>
        </div>
        <SettingStatus tone={ready ? 'good' : 'warn'}>
          {ready ? 'Ready to switch on' : 'Setup needed'}
        </SettingStatus>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-100">
        {/* --- what customers can book, and whether we can do it ----------- */}
        <div className="p-5">
          <div className="flex items-baseline justify-between gap-3 mb-3">
            <h3 className="text-sm font-medium text-slate-900">Services customers can book</h3>
            <span className="text-sm text-slate-500">
              {readyCount} of {r.publicServices.length} ready
            </span>
          </div>
          <ul className="space-y-1.5">
            {r.publicServices.map((s) => (
              <li key={s.code} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-slate-700 truncate">{s.name}</span>
                <span className="flex items-center gap-2 shrink-0">
                  {s.requiredCapability && (
                    <span className="text-xs text-slate-400">
                      {CAPABILITY_LABEL[s.requiredCapability] ?? s.requiredCapability}
                    </span>
                  )}
                  {s.status === 'READY' ? (
                    <span className="text-xs text-emerald-700 font-medium">
                      {s.verifiedEligiblePositions} position{s.verifiedEligiblePositions === 1 ? '' : 's'}
                      {s.singlePointOfFailure && <span className="text-amber-700"> · only one</span>}
                    </span>
                  ) : (
                    <span className="text-xs text-red-700 font-medium">No bay set up</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* --- the workshop, and what is holding things up ------------------ */}
        <div className="p-5 space-y-4">
          <div>
            <h3 className="text-sm font-medium text-slate-900 mb-2">Workshop</h3>
            <dl className="space-y-1 text-sm">
              <Line label="Confirmed work positions" value={String(r.current.verifiedActivePositions)} />
              {r.current.provisionalIdentities > 0 && (
                <Line
                  label="Still to check in the building"
                  value={String(r.current.provisionalIdentities)}
                  note="Counted, but matched from names rather than confirmed"
                />
              )}
              {r.current.optionalUnverifiedResources > 0 && (
                <Line
                  label="Not yet classified"
                  value={String(r.current.optionalUnverifiedResources)}
                  note="Count for nothing — safe to leave, but capacity you are not using"
                />
              )}
            </dl>
          </div>

          {r.production.blockers.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-slate-900 mb-1.5">Before it can be switched on</h3>
              <ul className="space-y-1.5">
                {r.production.blockers.map((b) => (
                  <li key={b.label} className="text-sm text-slate-600 leading-relaxed">
                    <span className="font-medium text-slate-800">{b.label}.</span> {b.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
            <RelatedLink href="/admin/resources">Manage Resources &amp; Bays</RelatedLink>
            <RelatedLink href="/admin/resources/reconciliation">Confirm Work Positions</RelatedLink>
          </div>
        </div>
      </div>
    </section>
  );
}

function Line({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-slate-600">{label}</dt>
        <dd className="font-semibold text-slate-900 tabular-nums">{value}</dd>
      </div>
      {note && <p className="text-xs text-slate-400 leading-snug">{note}</p>}
    </div>
  );
}
