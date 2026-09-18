'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';

/**
 * CR-2026-108 Stage 5C §11 — the Booking Simulator, with both capacity models.
 *
 * Left column: what a customer actually gets right now, from the fixed limit.
 * Right column: what the resource-aware model would have said, given the bays
 * that are configured, what each can do, and what is already booked.
 *
 * The screen exists to make CONFIGURATION PROBLEMS obvious. A slot that reads
 * "LUBE_CAPACITY_NOT_VERIFIED" is not telling you the shop is full — it is
 * telling you nobody has said which bay does oil changes, and those two must
 * never look the same.
 */

type ShadowStatus = 'AVAILABLE' | 'BLOCKED' | 'INCOMPLETE';

interface SlotComparison {
  startAt: string;
  endAt: string;
  fixed: { available: boolean; reasonCode: string; rule?: string };
  shadow: {
    status: ShadowStatus;
    available: boolean;
    reasonCode: string;
    label: string;
    detail: string;
    eligiblePositions: number;
    remainingPositions: number;
    eligibleCodes: string[];
  };
  agrees: boolean;
}

interface Simulation {
  site: { name: string; timezone: string };
  plannedMinutes: number;
  range: { from: string; to: string };
  services: Array<{ code: string; name: string; requiredBayType: string | null }>;
  productionModel: string;
  shadow: {
    requiredCapability: string | null;
    configurationComplete: boolean;
    unverifiedResourceCount: number;
    fingerprint: string;
    summary: {
      slotsCompared: number;
      agree: number;
      oversold: number;
      undersold: number;
      incomplete: number;
      eligiblePositions: number;
    };
    days: Array<{ date: string; slots: SlotComparison[] }>;
    headline: string;
  };
  resourceConfiguration: {
    verifiedActivePositions: number;
    unverifiedResources: number;
    capabilityPositions: Record<string, number>;
    requiredCapability: string | null;
  };
}

interface ServiceType {
  code: string;
  name: string;
  customerFacingName: string | null;
  bookableOnline: boolean;
  requiredBayType: string | null;
}

const time = (iso: string, tz: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });

/** Reason codes in words. Operational vocabulary never reaches a customer, but
 *  an analyst still deserves a sentence rather than an enum. */
const FIXED_REASON: Record<string, string> = {
  AVAILABLE: 'Offered',
  FIXED_CAPACITY_REACHED: 'At the fixed limit',
  MINIMUM_NOTICE: 'Inside the notice period',
  PAST: 'In the past',
  CUSTOMER_LATEST_START: 'After the latest start',
  OUTSIDE_OPENING_HOURS: 'Would not finish before close',
};

export default function BookingSimulatorPage() {
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState(3);
  const [audience, setAudience] = useState<'CUSTOMER' | 'STAFF'>('CUSTOMER');
  const [vehicleClass, setVehicleClass] = useState('');
  const [onlyDifferences, setOnlyDifferences] = useState(false);

  const servicesQuery = useQuery<ServiceType[]>({
    queryKey: ['simulator-services'],
    queryFn: () => api.get('/service-types'),
  });

  const codes = selected.join(',');
  const sim = useQuery<Simulation>({
    queryKey: ['simulation', codes, days, audience, vehicleClass],
    queryFn: () =>
      api.get(
        `/admin/testing/booking/simulate?serviceCodes=${encodeURIComponent(codes)}&days=${days}&audience=${audience}` +
          (vehicleClass ? `&vehicleClass=${vehicleClass}` : ''),
      ),
    enabled: selected.length > 0,
  });

  const services = servicesQuery.data ?? [];
  const pilot = services.filter((s) => s.bookableOnline);
  const others = services.filter((s) => !s.bookableOnline);

  return (
    <div className="p-6 max-w-[1400px]">
      <PageHeader
        title="Booking Simulator"
        subtitle="What a customer is offered, and what the resource-aware model would have said"
        breadcrumbs={[{ label: 'Setup', href: '/admin' }, { label: 'Booking Simulator' }]}
      />

      {/* --- the question ------------------------------------------------- */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-2">Which service?</label>
          <div className="flex flex-wrap gap-2">
            {pilot.map((s) => (
              <ServiceChip key={s.code} s={s} selected={selected} setSelected={setSelected} online />
            ))}
          </div>
          {others.length > 0 && (
            <details className="mt-3">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                Services not offered online ({others.length})
              </summary>
              <div className="flex flex-wrap gap-2 mt-2">
                {others.map((s) => (
                  <ServiceChip key={s.code} s={s} selected={selected} setSelected={setSelected} />
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <Field label="Days">
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="px-3 py-2 text-sm rounded-lg border border-slate-200">
              {[1, 3, 7, 14].map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Booking as">
            <select value={audience} onChange={(e) => setAudience(e.target.value as 'CUSTOMER' | 'STAFF')} className="px-3 py-2 text-sm rounded-lg border border-slate-200">
              <option value="CUSTOMER">A customer online</option>
              <option value="STAFF">Front desk</option>
            </select>
          </Field>
          <Field label="Vehicle">
            <select value={vehicleClass} onChange={(e) => setVehicleClass(e.target.value)} className="px-3 py-2 text-sm rounded-lg border border-slate-200">
              <option value="">Any vehicle</option>
              <option value="SEDAN_CLASS">Sedan</option>
              <option value="SUV_CLASS">SUV</option>
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-600 pb-2">
            <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
            Only show where the two disagree
          </label>
        </div>
      </div>

      {selected.length === 0 && (
        <p className="text-sm text-slate-500">Pick a service to compare the two models.</p>
      )}
      {sim.isLoading && selected.length > 0 && <LoadingState />}
      {sim.data && <Comparison sim={sim.data} onlyDifferences={onlyDifferences} />}
    </div>
  );
}

function Comparison({ sim, onlyDifferences }: { sim: Simulation; onlyDifferences: boolean }) {
  const s = sim.shadow.summary;
  const tz = sim.site.timezone;

  return (
    <>
      {/* --- what the comparison found ------------------------------------ */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap gap-x-8 gap-y-3 mb-3">
          <Stat label="Slots compared" value={s.slotsCompared} />
          <Stat label="Both agree" value={s.agree} tone="good" />
          <Stat label="Fixed offered, no bay free" value={s.oversold} tone={s.oversold > 0 ? 'bad' : undefined} />
          <Stat label="Fixed refused, bays free" value={s.undersold} tone={s.undersold > 0 ? 'warn' : undefined} />
          <Stat label="Could not evaluate" value={s.incomplete} tone={s.incomplete > 0 ? 'warn' : undefined} />
        </div>
        <p className="text-sm text-slate-700">{sim.shadow.headline}</p>
        <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500 leading-relaxed">
          This service needs{' '}
          <span className="font-medium text-slate-700">{sim.resourceConfiguration.requiredCapability ?? 'no particular kind of bay'}</span>
          {sim.resourceConfiguration.requiredCapability && (
            <> — {s.eligiblePositions} position{s.eligiblePositions === 1 ? '' : 's'} can do it</>
          )}
          . The shop has {sim.resourceConfiguration.verifiedActivePositions} confirmed position
          {sim.resourceConfiguration.verifiedActivePositions === 1 ? '' : 's'} available
          {sim.resourceConfiguration.unverifiedResources > 0 && (
            <>, and {sim.resourceConfiguration.unverifiedResources} resource
              {sim.resourceConfiguration.unverifiedResources === 1 ? '' : 's'} nobody has classified yet — so these counts are a lower bound</>
          )}
          .
        </div>
      </div>

      {/* --- slot by slot -------------------------------------------------- */}
      {sim.shadow.days.map((day) => {
        const slots = onlyDifferences ? day.slots.filter((x) => !x.agrees) : day.slots;
        if (slots.length === 0) return null;
        return (
          <div key={day.date} className="mb-5 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                {new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
              </h3>
              <span className="text-xs text-slate-500">{slots.length} slot{slots.length === 1 ? '' : 's'}</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 px-4 font-medium w-24">Time</th>
                  <th className="py-2 px-4 font-medium w-56">Now (fixed limit)</th>
                  <th className="py-2 px-4 font-medium">Resource-aware (not live)</th>
                </tr>
              </thead>
              <tbody>
                {slots.map((slot) => (
                  <tr key={slot.startAt} className={`border-b border-slate-100 last:border-0 ${slot.agrees ? '' : 'bg-amber-50/40'}`}>
                    <td className="py-2 px-4 text-slate-600 tabular-nums">{time(slot.startAt, tz)}</td>
                    <td className="py-2 px-4">
                      <Pill ok={slot.fixed.available} text={slot.fixed.available ? 'Available' : 'Blocked'} />
                      <span className="block text-xs text-slate-500 mt-0.5">
                        {FIXED_REASON[slot.fixed.reasonCode] ?? slot.fixed.reasonCode}
                      </span>
                    </td>
                    <td className="py-2 px-4">
                      <ShadowCell slot={slot} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

function ShadowCell({ slot }: { slot: SlotComparison }) {
  const { shadow } = slot;
  const tone =
    shadow.status === 'AVAILABLE'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : shadow.status === 'INCOMPLETE'
        ? 'bg-amber-50 text-amber-800 border-amber-200'
        : 'bg-red-50 text-red-700 border-red-200';
  const word = shadow.status === 'AVAILABLE' ? 'Available' : shadow.status === 'INCOMPLETE' ? 'Cannot tell' : 'Blocked';

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-2 py-0.5 rounded text-xs font-medium border ${tone}`}>{word}</span>
        {shadow.label !== 'AVAILABLE' && (
          <code className="text-xs text-slate-500 font-mono">{shadow.label}</code>
        )}
        {shadow.status === 'AVAILABLE' && shadow.eligiblePositions > 0 && (
          <span className="text-xs text-slate-500">
            {shadow.remainingPositions} of {shadow.eligiblePositions} eligible position
            {shadow.eligiblePositions === 1 ? '' : 's'} free
          </span>
        )}
      </div>
      <span className="block text-xs text-slate-500 mt-0.5 leading-relaxed">{shadow.detail}</span>
      {shadow.eligibleCodes.length > 0 && shadow.status !== 'AVAILABLE' && (
        <span className="block text-xs text-slate-400 mt-0.5">Could use: {shadow.eligibleCodes.join(', ')}</span>
      )}
    </div>
  );
}

function ServiceChip({
  s,
  selected,
  setSelected,
  online,
}: {
  s: ServiceType;
  selected: string[];
  setSelected: (v: string[]) => void;
  online?: boolean;
}) {
  const on = selected.includes(s.code);
  return (
    <button
      onClick={() => setSelected(on ? selected.filter((c) => c !== s.code) : [...selected, s.code])}
      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
        on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
      }`}
      title={s.requiredBayType ? `Needs a ${s.requiredBayType} position` : 'No particular kind of bay'}
    >
      {s.customerFacingName?.trim() || s.name}
      {online && <span className={`ml-1.5 ${on ? 'text-slate-300' : 'text-slate-400'}`}>online</span>}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
      {children}
    </div>
  );
}

function Pill({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium border ${
        ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'
      }`}
    >
      {text}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900';
  return (
    <div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}
