'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * CR-2026-108 §22 — the capacity strip on Resources & Bays.
 *
 * Three questions a manager actually asks: how many positions do we have, what
 * can each kind of work be done on, and is the smarter scheduling model safe to
 * turn on yet.
 *
 * The capability table is deliberately a LIST with no total row. One bay that can
 * do three kinds of work appears in three rows and is still one vehicle at a time,
 * so a total would read as capacity the shop does not have. The note under the
 * table says so, because the table invites exactly that mistake.
 */

interface CapacitySummary {
  configuration: {
    verifiedActivePrimary: number;
    verifiedActiveOverflow: number;
    unverifiedCandidates: number;
    supportEquipment: number;
    placeholders: number;
    unavailableToday: Array<{ code: string; name: string; status: string; reason: string | null }>;
    retired: number;
  };
  capabilityAvailability: Array<{
    capability: string;
    eligiblePositions: number;
    verified: boolean;
    requiredByPublicServices: string[];
  }>;
  capabilityNote: string;
  scheduling: {
    productionModel: string;
    productionConcurrencyLimit: number | null;
    shadowModel: string;
    resourceAwareProductionReady: boolean;
    readinessSummary: string;
    blockers: Array<{ label: string; detail: string }>;
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

export function CapacitySummary({ siteId }: { siteId: string }) {
  const q = useQuery<CapacitySummary>({
    queryKey: ['resource-capacity-summary', siteId],
    queryFn: () => api.get(`/resources/capacity-summary?siteId=${siteId}`),
    enabled: !!siteId,
    refetchInterval: 60_000,
  });

  if (!q.data) return null;
  const { configuration: c, capabilityAvailability, scheduling } = q.data;

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
        {/* --- what is configured ------------------------------------------ */}
        <div className="p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Work positions</h2>
          <dl className="space-y-1.5 text-sm">
            <Row label="Confirmed and available now" value={c.verifiedActivePrimary} strong />
            <Row label="Overflow positions confirmed" value={c.verifiedActiveOverflow} />
            <Row label="Not yet confirmed" value={c.unverifiedCandidates} tone={c.unverifiedCandidates > 0 ? 'warn' : undefined} />
            <Row label="Equipment (never a position)" value={c.supportEquipment} />
            {c.placeholders > 0 && <Row label="Planned, not built" value={c.placeholders} />}
            <Row label="Unavailable today" value={c.unavailableToday.length} tone={c.unavailableToday.length > 0 ? 'warn' : undefined} />
          </dl>
          {c.unavailableToday.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {c.unavailableToday.map((r) => (
                <li key={r.code} className="text-xs text-amber-700">
                  {r.code} — {r.status.replace(/_/g, ' ').toLowerCase()}
                  {r.reason ? `: ${r.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
          {c.unverifiedCandidates > 0 && (
            <p className="mt-3 text-xs text-slate-500 leading-relaxed">
              Anything not yet confirmed counts for nothing — deliberately. It is not a guess that it is useless; it is
              the absence of a decision.
            </p>
          )}
        </div>

        {/* --- what each kind of work has ----------------------------------- */}
        <div className="p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">What we can work on</h2>
          <table className="w-full text-sm">
            <tbody>
              {capabilityAvailability.map((cap) => (
                <tr key={cap.capability} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 text-slate-700">{CAPABILITY_LABEL[cap.capability] ?? cap.capability}</td>
                  <td className="py-1.5 text-right">
                    {cap.verified ? (
                      <span className="font-medium text-slate-900">
                        {cap.eligiblePositions} position{cap.eligiblePositions === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-amber-700">Not set up</span>
                    )}
                  </td>
                  <td className="py-1.5 pl-3 text-right w-24">
                    {cap.requiredByPublicServices.length > 0 && (
                      <span
                        className={`text-xs ${cap.verified ? 'text-slate-400' : 'text-amber-700 font-medium'}`}
                        title={`Booked online: ${cap.requiredByPublicServices.join(', ')}`}
                      >
                        {cap.requiredByPublicServices.length} online
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-slate-500 leading-relaxed">
            These are <span className="font-medium text-slate-700">not added together</span>. One bay that can do three
            kinds of work appears in three rows and is still one vehicle at a time.
          </p>
        </div>

        {/* --- scheduling --------------------------------------------------- */}
        <div className="p-5">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Scheduling</h2>
          <dl className="space-y-1.5 text-sm">
            <Row
              label="Deciding bookings now"
              text={
                scheduling.productionModel === 'FIXED'
                  ? `Fixed limit of ${scheduling.productionConcurrencyLimit ?? '—'}`
                  : 'Resource-aware'
              }
            />
            <Row label="Running alongside" text="Resource-aware (diagnostic only)" />
          </dl>
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
              scheduling.resourceAwareProductionReady
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-slate-200 bg-slate-50 text-slate-700'
            }`}
          >
            <span className="font-semibold">
              {scheduling.resourceAwareProductionReady ? 'Ready to switch over' : 'Not ready to switch over'}
            </span>
            <span className="block mt-0.5">{scheduling.readinessSummary}</span>
          </div>
          {scheduling.blockers.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {scheduling.blockers.map((b) => (
                <li key={b.label} className="text-xs text-slate-600 leading-relaxed">
                  <span className="font-medium text-slate-800">{b.label}.</span> {b.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  text,
  strong,
  tone,
}: {
  label: string;
  value?: number;
  text?: string;
  strong?: boolean;
  tone?: 'warn';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd
        className={`tabular-nums ${strong ? 'text-lg font-bold text-slate-900' : tone === 'warn' ? 'font-medium text-amber-700' : 'text-slate-900'}`}
      >
        {text ?? value}
      </dd>
    </div>
  );
}
