'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api-client';

/**
 * CR-2026-108 §14 — the capacity strip on Resources & Bays.
 *
 * Three things a manager actually needs: what the shop is configured with, what
 * each kind of work can run on, and whether the smarter scheduling model is safe
 * to switch on.
 *
 * Two deliberate choices:
 *
 *  - The capability table has NO TOTAL ROW. One bay that does three kinds of work
 *    appears in three rows and is still one vehicle at a time, so a total would
 *    read as capacity the shop does not have.
 *  - Blockers and warnings are visually separate. A warning is a resource that
 *    contributes ZERO and that no public service depends on; ignoring it makes
 *    the model conservative, so it must be loud without looking like a fault.
 */

interface CapacitySummary {
  configuration: {
    confirmedHeavyLiftPositions: number;
    verifiedActiveOverflow: number;
    optionalUnverified: number;
    supportEquipment: number;
    placeholders: number;
    external: number;
    provisionalIdentities: string[];
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
  publicServices: Array<{
    code: string;
    name: string;
    requiredCapability: string | null;
    verifiedEligiblePositions: number;
    status: 'READY' | 'INCOMPLETE';
    singlePointOfFailure: boolean;
    detail: string;
  }>;
  scheduling: {
    customerCatalogueServices: number;
    productionModel: string;
    productionConcurrencyLimit: number | null;
    productionDurationSource: string;
    shadowModel: string;
    shadowReady: boolean;
    resourceAwareProductionReady: boolean;
    readinessSummary: string;
    blockers: Array<{ label: string; detail: string }>;
    warnings: Array<{ label: string; detail: string }>;
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
  const { configuration: c, capabilityAvailability, publicServices, scheduling } = q.data;
  const incomplete = publicServices.filter((s) => s.status === 'INCOMPLETE');

  return (
    <div className="mb-6 space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
          {/* --- physical configuration ------------------------------------- */}
          <div className="p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Physical resource configuration</h2>
            <dl className="space-y-1.5 text-sm">
              <Row label="Confirmed heavy-lift positions" value={c.confirmedHeavyLiftPositions} strong />
              <Row label="Verified overflow positions" value={c.verifiedActiveOverflow} />
              <Row label="Optional / unverified" value={c.optionalUnverified} tone={c.optionalUnverified > 0 ? 'warn' : undefined} />
              <Row label="Support equipment" value={c.supportEquipment} />
              {c.placeholders > 0 && <Row label="Planned, not built" value={c.placeholders} />}
              <Row label="Unavailable today" value={c.unavailableToday.length} tone={c.unavailableToday.length > 0 ? 'warn' : undefined} />
              {c.external > 0 && <Row label="External (not our capacity)" value={c.external} />}
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

            {/*
              §1 — the COUNT of eight is management-confirmed. WHICH record is
              WHICH bay was matched from names and codes. Saying so is the whole
              point: an inference that looks verified is how it becomes one.
            */}
            {c.provisionalIdentities.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs font-semibold text-slate-700">Provisional — needs checking in the building</p>
                <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                  {c.provisionalIdentities.join(', ')} were matched from their names and codes. The number of positions is
                  confirmed; which record is which bay is not. They still count toward capacity — tick them off on{' '}
                  <span className="font-medium">Confirm Work Positions</span> as you check each one.
                </p>
              </div>
            )}

            {c.optionalUnverified > 0 && (
              <p className="mt-3 text-xs text-slate-500 leading-relaxed">
                Unverified resources contribute <span className="font-medium text-slate-700">nothing</span>, so ignoring
                them can only under-offer capacity, never over-offer it. That is why they do not block anything.
              </p>
            )}
          </div>

          {/* --- capability availability ------------------------------------- */}
          <div className="p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Current verified service capability</h2>
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
                        <span className="text-amber-700">Not configured</span>
                      )}
                    </td>
                    <td className="py-1.5 pl-3 text-right w-20">
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

          {/* --- scheduling state -------------------------------------------- */}
          <div className="p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Scheduling state</h2>
            <dl className="space-y-1.5 text-sm">
              <Row label="Customer catalogue" text={`${scheduling.customerCatalogueServices} services`} />
              <Row
                label="Deciding bookings now"
                text={
                  scheduling.productionModel === 'FIXED'
                    ? `Fixed limit of ${scheduling.productionConcurrencyLimit ?? '—'}`
                    : 'Resource-aware'
                }
              />
              <Row label="Appointment lengths" text={scheduling.productionDurationSource === 'DEFAULT' ? 'Standard 80 min' : 'From the catalogue'} />
              <Row label="Running alongside" text="Resource-aware (diagnostic)" />
              <Row label="Diagnostics" text={scheduling.shadowReady ? 'Ready' : 'Not ready'} />
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
          </div>
        </div>
      </div>

      {/* --- §8 the activation gate, service by service --------------------- */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
          <h2 className="text-sm font-semibold text-slate-900">Can we do what customers can book?</h2>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
            This is what decides whether the resource-aware model can take over. An unclassified jack does not.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="py-2 px-5 font-medium">Service</th>
              <th className="py-2 px-3 font-medium">Needs</th>
              <th className="py-2 px-3 font-medium text-right">Verified positions</th>
              <th className="py-2 px-5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {publicServices.map((s) => (
              <tr key={s.code} className="border-b border-slate-100 last:border-0">
                <td className="py-2 px-5 text-slate-900">{s.name}</td>
                <td className="py-2 px-3 text-slate-600">
                  {s.requiredCapability ? CAPABILITY_LABEL[s.requiredCapability] ?? s.requiredCapability : 'Any position'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums font-medium text-slate-900">
                  {s.verifiedEligiblePositions}
                </td>
                <td className="py-2 px-5">
                  {s.status === 'READY' ? (
                    <span className="px-2 py-0.5 rounded text-xs font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                      Ready
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-xs font-medium border bg-red-50 text-red-700 border-red-200">
                      Incomplete
                    </span>
                  )}
                  {s.singlePointOfFailure && (
                    <span className="ml-2 text-xs text-amber-700" title="One position is a valid answer if one is what exists.">
                      single position
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {incomplete.length > 0 && (
          <div className="px-5 py-3 bg-red-50 border-t border-red-100">
            <p className="text-xs text-red-900 leading-relaxed">
              <span className="font-semibold">A customer can book these and we have no confirmed way to do them.</span>{' '}
              Set the required capability on whichever position actually does the work — one is enough if one is what
              exists.
            </p>
          </div>
        )}
      </div>

      {/* --- blockers and warnings, visually separate ----------------------- */}
      {(scheduling.blockers.length > 0 || scheduling.warnings.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {scheduling.blockers.length > 0 && (
            <FindingList
              title={`Blocking resource-aware scheduling (${scheduling.blockers.length})`}
              help="Each of these means a customer could book work we cannot confirm we can do."
              items={scheduling.blockers}
              tone="bad"
            />
          )}
          {scheduling.warnings.length > 0 && (
            <FindingList
              title={`Worth knowing (${scheduling.warnings.length})`}
              help="These do not block anything. They describe capacity we are choosing not to count, or facts worth checking."
              items={scheduling.warnings}
              tone="warn"
            />
          )}
        </div>
      )}
    </div>
  );
}

function FindingList({
  title,
  help,
  items,
  tone,
}: {
  title: string;
  help: string;
  items: Array<{ label: string; detail: string }>;
  tone: 'bad' | 'warn';
}) {
  const head = tone === 'bad' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200';
  const text = tone === 'bad' ? 'text-red-900' : 'text-amber-900';
  return (
    <div className={`rounded-xl border overflow-hidden ${tone === 'bad' ? 'border-red-200' : 'border-amber-200'}`}>
      <div className={`px-4 py-2.5 border-b ${head}`}>
        <h3 className={`text-sm font-semibold ${text}`}>{title}</h3>
        <p className={`text-xs mt-0.5 leading-relaxed ${text} opacity-80`}>{help}</p>
      </div>
      <ul className="divide-y divide-slate-100 bg-white">
        {items.map((i) => (
          <li key={i.label} className="px-4 py-2.5">
            <span className="text-sm font-medium text-slate-900">{i.label}</span>
            <span className="block text-xs text-slate-600 mt-0.5 leading-relaxed">{i.detail}</span>
          </li>
        ))}
      </ul>
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
