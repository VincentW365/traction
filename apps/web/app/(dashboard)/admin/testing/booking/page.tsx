'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { PageHeader } from '../../../../../components/ui/page-header';
import { LoadingState } from '../../../../../components/ui/loading-state';

/**
 * CR-2026-108 Stage 3 — Setup → Testing → Booking Simulator.
 *
 * Answers "why is a customer not being offered Tuesday at 10?" from the SAME
 * production availability service the public page runs. It deliberately holds no
 * availability logic of its own: if this screen re-implemented the rules it would
 * be explaining a system that does not exist.
 *
 * Everything here is internal — capacity numbers, rule values, later resource
 * facts — which is exactly what /book must never show. The endpoint behind it is
 * permission-gated on booking:simulate.
 */

interface SlotDecision {
  startAt: string;
  endAt: string;
  available: boolean;
  reasonCode: string;
  plannedMinutes: number;
  capacity: { before: number; after: number; limit: number; reserved?: number; resourceCapacity?: number | null };
  rule?: string;
}
interface DayDecision {
  date: string;
  closed: boolean;
  reasonCode?: string;
  slots: SlotDecision[];
  availableCount: number;
}
interface SimulationResult {
  site: { id: string; code: string; name: string; timezone: string };
  audience: 'CUSTOMER' | 'STAFF';
  plannedMinutes: number;
  latestStartLabel: string | null;
  range: { from: string; to: string };
  services: Array<{ code: string; name: string; baseDurationMinutes: number | null }>;
  productionModel: 'FIXED' | 'SHADOW' | 'RESOURCE_AWARE';
  shadow: { status: 'NOT_YET_AVAILABLE' | 'AVAILABLE'; note?: string };
  decision: { nextAvailable: SlotDecision | null; days: DayDecision[] };
}
interface ServiceOption { code: string; name: string }
interface UatSession {
  token: string; runLabel: string; testDataRunId: string;
  expiresAt: string; bookingUrl: string | null; ttlMinutes: number;
}

/** Plain-language labels. The code is shown too — an analyst needs both. */
const REASON_LABEL: Record<string, string> = {
  AVAILABLE: 'Offered',
  MINIMUM_NOTICE: 'Too soon — inside the minimum notice',
  PAST: 'In the past',
  CUSTOMER_LATEST_START: 'After the latest start time customers may book',
  OUTSIDE_OPENING_HOURS: 'Would not finish before closing',
  CLOSED_WEEKDAY: 'Closed this weekday',
  CLOSED_DATE: 'Closed on this date',
  SAME_DAY_NOT_ALLOWED: 'Same-day online booking is off',
  OUTSIDE_ADVANCE_WINDOW: 'Beyond how far ahead customers may book',
  FIXED_CAPACITY_REACHED: 'All service positions are taken at that time',
  ONLINE_RESERVE_REACHED: 'Remaining positions are held back for walk-ins',
  RESOURCE_CAPACITY_REACHED: 'No capacity-contributing resource is free',
  REQUIRED_RESOURCE_UNAVAILABLE: 'The required bay/resource type is not available',
  VEHICLE_CLASS_NOT_SUPPORTED: 'No available resource supports this vehicle class',
  SERVICE_NOT_BOOKABLE_ONLINE: 'This service is not bookable online',
  DUPLICATE_VEHICLE_BOOKING: 'This vehicle already has a booking that day',
  BOOKING_DISABLED: 'Online booking is switched off',
};

const CHIP: Record<string, string> = {
  AVAILABLE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  FIXED_CAPACITY_REACHED: 'bg-red-50 text-red-700 border-red-200',
  MINIMUM_NOTICE: 'bg-amber-50 text-amber-800 border-amber-200',
  PAST: 'bg-slate-100 text-slate-500 border-slate-200',
  CUSTOMER_LATEST_START: 'bg-violet-50 text-violet-700 border-violet-200',
  OUTSIDE_OPENING_HOURS: 'bg-slate-100 text-slate-500 border-slate-200',
};

function fmtTime(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  } catch {
    return iso;
  }
}

export default function BookingSimulatorPage() {
  const [serviceCodes, setServiceCodes] = useState('');
  const [from, setFrom] = useState('');
  const [days, setDays] = useState('3');
  const [audience, setAudience] = useState<'CUSTOMER' | 'STAFF'>('CUSTOMER');
  const [ran, setRan] = useState(false);
  const [uatLabel, setUatLabel] = useState('');
  const [session, setSession] = useState<UatSession | null>(null);

  const servicesQ = useQuery<{ services?: ServiceOption[] } | ServiceOption[]>({
    queryKey: ['sim-services'],
    queryFn: () => api.get('/public/booking/services'),
  });
  const serviceList: ServiceOption[] = Array.isArray(servicesQ.data)
    ? servicesQ.data
    : (servicesQ.data?.services ?? []);

  const simQ = useQuery<SimulationResult>({
    queryKey: ['booking-sim', serviceCodes, from, days, audience],
    queryFn: () =>
      api.get(
        `/admin/testing/booking/simulate?serviceCodes=${encodeURIComponent(serviceCodes)}` +
          `&days=${encodeURIComponent(days)}&audience=${audience}${from ? `&from=${from}` : ''}`,
      ),
    enabled: ran && serviceCodes.length > 0,
  });

  const startSession = useMutation<UatSession>({
    mutationFn: () => api.post('/admin/testing/booking/uat-session', { label: uatLabel || undefined }),
    onSuccess: (s) => setSession(s),
  });

  const data = simQ.data;
  const tz = data?.site.timezone ?? 'America/Jamaica';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Booking Simulator"
        subtitle="Why a customer is — or is not — offered a time. Runs the same engine as the public booking page."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Setup' }, { label: 'Testing' }, { label: 'Booking' }]}
      />

      {/* ---------------- Controls ---------------- */}
      <div className="card">
        <div className="card-body grid gap-3 sm:grid-cols-5">
          <label className="text-xs text-slate-600 sm:col-span-2">
            Service
            <select
              className="input mt-1 w-full"
              value={serviceCodes}
              onChange={(e) => { setServiceCodes(e.target.value); setRan(false); }}
            >
              <option value="">Choose a service…</option>
              {serviceList.map((s) => (
                <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            From
            <input type="date" className="input mt-1 w-full" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="text-xs text-slate-600">
            Days
            <input type="number" min={1} max={14} className="input mt-1 w-full" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="text-xs text-slate-600">
            Seen as
            <select className="input mt-1 w-full" value={audience} onChange={(e) => setAudience(e.target.value as 'CUSTOMER' | 'STAFF')}>
              <option value="CUSTOMER">Customer</option>
              <option value="STAFF">Staff</option>
            </select>
          </label>
          <div className="sm:col-span-5">
            <button className="btn btn-primary" disabled={!serviceCodes} onClick={() => setRan(true)}>
              Run simulation
            </button>
          </div>
        </div>
      </div>

      {simQ.isLoading && <LoadingState message="Running the availability engine…" />}
      {simQ.isError && <p className="text-sm text-red-700">{(simQ.error as Error).message}</p>}

      {data && (
        <>
          {/* ---------------- Model comparison ---------------- */}
          <div className="card">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Capacity model</h2></div>
            <div className="card-body grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Production model</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{data.productionModel}</p>
                <p className="text-xs text-slate-600">This is what a real customer is seeing right now.</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Shadow model</p>
                <p className="mt-1 text-lg font-bold text-slate-500">
                  {data.shadow.status === 'NOT_YET_AVAILABLE' ? 'Not yet available' : 'Resource-aware'}
                </p>
                {data.shadow.note && <p className="text-xs text-slate-600">{data.shadow.note}</p>}
              </div>
            </div>
          </div>

          {/* ---------------- Context ---------------- */}
          <div className="card">
            <div className="card-body flex flex-wrap gap-x-8 gap-y-2 text-xs text-slate-700">
              <span>Planned duration: <strong>{data.plannedMinutes} min</strong></span>
              <span>Audience: <strong>{data.audience}</strong></span>
              <span>Range: <strong>{data.range.from} → {data.range.to}</strong></span>
              {data.latestStartLabel && <span>Latest start: <strong>{data.latestStartLabel}</strong></span>}
              <span>Next available: <strong>{data.decision.nextAvailable ? fmtTime(data.decision.nextAvailable.startAt, tz) : 'none in range'}</strong></span>
            </div>
          </div>

          {/* ---------------- Per-slot decisions ---------------- */}
          {data.decision.days.map((d) => (
            <div key={d.date} className="card">
              <div className="card-header flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">{d.date}</h3>
                <span className="text-xs text-slate-500">
                  {d.closed ? REASON_LABEL[d.reasonCode ?? ''] ?? d.reasonCode : `${d.availableCount} of ${d.slots.length} offered`}
                </span>
              </div>
              {!d.closed && (
                <div className="card-body overflow-x-auto">
                  <table className="table text-xs">
                    <thead>
                      <tr>
                        <th>Time</th><th>Decision</th><th>Why</th>
                        <th>Capacity before</th><th>After</th><th>Limit</th><th>Rule</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.slots.map((s) => (
                        <tr key={s.startAt}>
                          <td className="font-mono">{fmtTime(s.startAt, tz)}–{fmtTime(s.endAt, tz)}</td>
                          <td>
                            <span className={`badge border text-[10px] ${CHIP[s.reasonCode] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                              {s.available ? 'AVAILABLE' : 'BLOCKED'}
                            </span>
                          </td>
                          <td>
                            <div className="text-slate-800">{REASON_LABEL[s.reasonCode] ?? s.reasonCode}</div>
                            <div className="font-mono text-[10px] text-slate-400">{s.reasonCode}</div>
                          </td>
                          <td className="text-center">{s.capacity.before}</td>
                          <td className="text-center">{s.capacity.after}</td>
                          <td className="text-center">{s.capacity.limit}</td>
                          <td className="font-mono text-[10px] text-slate-500">{s.rule ?? '--'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {/* ---------------- UAT booking session ---------------- */}
      <div className="card">
        <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">UAT booking session</h2></div>
        <div className="card-body space-y-3">
          <p className="text-xs text-slate-600">
            Opens the <strong>real</strong> booking page inside a short-lived test session. A customer and vehicle
            created during it are tagged to the test run, their confirmation is captured instead of sent, and
            the standard test-run cleanup removes them. This is the only way to test the brand-new-customer
            path without contacting a real person.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-600">
              Run label (optional)
              <input className="input mt-1" placeholder="uat-booking-…" value={uatLabel} onChange={(e) => setUatLabel(e.target.value)} />
            </label>
            <button className="btn btn-secondary" disabled={startSession.isPending} onClick={() => startSession.mutate()}>
              {startSession.isPending ? 'Starting…' : 'Start UAT session'}
            </button>
          </div>
          {startSession.isError && <p className="text-xs text-red-700">{(startSession.error as Error).message}</p>}
          {session && (
            <div className="rounded-md border border-violet-200 bg-violet-50 p-3 text-xs">
              <p className="font-semibold text-violet-900">Session started — run “{session.runLabel}”</p>
              <p className="mt-1 text-violet-800">
                Valid {session.ttlMinutes} minutes (until {new Date(session.expiresAt).toLocaleTimeString()}).
              </p>
              {session.bookingUrl ? (
                <p className="mt-2 break-all">
                  <a className="font-mono text-blue-700 underline" href={session.bookingUrl} target="_blank" rel="noreferrer">
                    {session.bookingUrl}
                  </a>
                </p>
              ) : (
                <p className="mt-2 text-violet-800">
                  PUBLIC_APP_URL is not set, so no link could be built. Open /book and supply the token as
                  <code className="mx-1">?uat=</code>.
                </p>
              )}
              <p className="mt-2 text-violet-800">
                Afterwards, review what would have been sent under Communication history, or via
                <code className="mx-1">/notifications/captured?runLabel={session.runLabel}</code>.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
