'use client';

/**
 * CR-2026-105c — customer self-service pre-booking (public, no login).
 *
 * Identify (mobile + plate) → vehicle → service → next available slot → confirm →
 * "Appointment Confirmed" with a reference and a manage link. Everything goes
 * through the same Appointment record staff use. Privacy: this page never sees a
 * full plate, phone or another customer's data — the API masks them.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicApiError, fmtWhen, publicApi } from '../../lib/public-api';
import { SlotPicker, type Availability, type Slot } from './slot-picker';

interface SiteInfo {
  siteName: string;
  timezone: string;
  bookingEnabled: boolean;
  plannedMinutes: number;
  arrivalInstructions: string;
  advanceWindowDays: number;
}
interface Identified {
  known: boolean;
  sessionToken?: string;
  firstName?: string;
  phoneMasked?: string;
  vehicles?: Array<{ id: string; plateMasked: string; make: string | null; model: string | null; modelYear: number | null; matched: boolean }>;
}
interface ServiceOption {
  code: string;
  name: string;
  family: string | null;
  plannedMinutes: number;
}
interface Confirmation {
  appointmentNumber: string;
  scheduledStartAt: string;
  plannedMinutes: number;
  services: Array<{ code: string; name: string }>;
  vehicle: { plateMasked: string; make: string | null; model: string | null; modelYear: number | null };
  site: { name: string; timezone: string };
  arrivalInstructions: string;
  managePath: string;
}

type Step = 'identify' | 'details' | 'service' | 'slot' | 'confirm' | 'done';
const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'identify', label: 'You' },
  { key: 'details', label: 'Vehicle' },
  { key: 'service', label: 'Service' },
  { key: 'slot', label: 'Time' },
  { key: 'confirm', label: 'Confirm' },
];

function Shell({ site, children }: { site?: SiteInfo | null; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-5 flex items-center gap-3">
          <img src="/brand-mark.png" alt="" className="h-9 w-auto object-contain" />
          <div>
            <p className="text-base font-bold text-slate-900">{site?.siteName ?? 'Service Centre'}</p>
            <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">Book a service appointment</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function BookPage() {
  const [step, setStep] = useState<Step>('identify');
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [phone, setPhone] = useState('');
  const [plate, setPlate] = useState('');
  const [identified, setIdentified] = useState<Identified | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 2
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [addVehicle, setAddVehicle] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(true);
  const [emailOptIn, setEmailOptIn] = useState(true);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');

  // Step 3–5
  const [codes, setCodes] = useState<string[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [availabilityNonce, setAvailabilityNonce] = useState(0);
  const [done, setDone] = useState<Confirmation | null>(null);
  const [copied, setCopied] = useState(false);

  const siteQ = useQuery<SiteInfo>({ queryKey: ['public-site'], queryFn: () => publicApi.get('/public/booking/site'), retry: 3, retryDelay: 3000 });
  const servicesQ = useQuery<ServiceOption[]>({ queryKey: ['public-services'], queryFn: () => publicApi.get('/public/booking/services'), enabled: step !== 'identify' });
  const availabilityQ = useQuery<Availability>({
    queryKey: ['public-availability', codes.join(','), availabilityNonce],
    queryFn: () => publicApi.get(`/public/booking/availability?serviceCodes=${encodeURIComponent(codes.join(','))}&days=14`),
    enabled: (step === 'slot' || step === 'confirm') && codes.length > 0,
    staleTime: 20000,
  });

  useEffect(() => setError(null), [step]);

  const tz = siteQ.data?.timezone;
  const isNew = identified ? !identified.known : true;
  const needsVehicleForm = isNew || addVehicle;

  async function handleIdentify() {
    setBusy(true);
    setError(null);
    try {
      const res = await publicApi.post<Identified>('/public/booking/identify', { phone: phone.trim(), plateNumber: plate.trim() });
      setIdentified(res);
      if (res.known) {
        const matched = res.vehicles?.find((v) => v.matched) ?? res.vehicles?.[0];
        setVehicleId(matched?.id ?? null);
        setAddVehicle(false);
      } else {
        setVehicleId(null);
        setAddVehicle(true);
      }
      setStep('details');
    } catch (e) {
      setError(e instanceof PublicApiError ? e.message : 'We could not reach the service centre. Please try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  function detailsValid(): boolean {
    if (isNew && (!firstName.trim() || !lastName.trim())) return false;
    if (needsVehicleForm && !plate.trim()) return false;
    if (!needsVehicleForm && !vehicleId) return false;
    return true;
  }

  async function handleConfirm() {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        sessionToken: identified?.known ? identified.sessionToken : undefined,
        customer: isNew
          ? { firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(), email: email.trim() || undefined, smsOptIn, emailOptIn }
          : undefined,
        vehicleId: !needsVehicleForm ? vehicleId ?? undefined : undefined,
        vehicle: needsVehicleForm
          ? { plateNumber: plate.trim(), make: make.trim() || undefined, model: model.trim() || undefined, modelYear: year ? Number(year) : undefined }
          : undefined,
        serviceCodes: codes,
        scheduledStartAt: slot.startAt,
      };
      const res = await publicApi.post<Confirmation>('/public/booking/confirm', body);
      setDone(res);
      setStep('done');
    } catch (e) {
      if (e instanceof PublicApiError && e.code === 'SLOT_TAKEN') {
        setSlot(null);
        setAvailabilityNonce((n) => n + 1);
        setStep('slot');
        setError('Sorry — that time was just taken. Here are the current openings.');
      } else if (e instanceof PublicApiError && e.status === 403) {
        setIdentified(null);
        setStep('identify');
        setError(e.message);
      } else {
        setError(e instanceof PublicApiError ? e.message : 'We could not complete the booking. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (siteQ.isLoading) {
    return (
      <Shell>
        <div className="card p-6 text-center text-sm text-slate-500">Waking up the service centre… one moment.</div>
      </Shell>
    );
  }
  if (siteQ.isError || !siteQ.data) {
    return (
      <Shell>
        <div className="card p-6 text-center text-sm text-red-700">We could not reach the booking service. Please try again shortly or call the service centre.</div>
      </Shell>
    );
  }
  if (!siteQ.data.bookingEnabled) {
    return (
      <Shell site={siteQ.data}>
        <div className="card p-6 text-center text-sm text-amber-800">Online booking is currently unavailable. Please call the service centre to book.</div>
      </Shell>
    );
  }

  if (step === 'done' && done) {
    const manageUrl = typeof window !== 'undefined' ? `${window.location.origin}${done.managePath}` : done.managePath;
    return (
      <Shell site={siteQ.data}>
        <div className="card overflow-hidden">
          <div className="bg-emerald-600 px-5 py-4 text-white">
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-100">Appointment Confirmed</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{done.appointmentNumber}</p>
          </div>
          <div className="space-y-3 px-5 py-4 text-sm">
            <Row label="Date & arrival time" value={fmtWhen(done.scheduledStartAt, done.site.timezone)} strong />
            <Row label="Vehicle" value={[done.vehicle.modelYear, done.vehicle.make, done.vehicle.model].filter(Boolean).join(' ') || done.vehicle.plateMasked} sub={done.vehicle.plateMasked} />
            <Row label="Service" value={done.services.map((s) => s.name).join(', ')} />
            <Row label="Expected service time" value={`About ${done.plannedMinutes} minutes`} />
            <Row label="Service centre" value={done.site.name} />
            <div className="rounded-lg bg-slate-50 p-3 text-slate-700">{done.arrivalInstructions}</div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">View, move or cancel this appointment</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-700">{manageUrl}</p>
              <div className="mt-2 flex gap-2">
                <a href={done.managePath} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white">Open</a>
                <button
                  type="button"
                  onClick={async () => { try { await navigator.clipboard.writeText(manageUrl); setCopied(true); } catch { /* ignore */ } }}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">We have also sent this to you by text/email where you opted in. Keep the link private.</p>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <Shell site={siteQ.data}>
      {/* progress */}
      <ol className="mb-4 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider">
        {STEPS.map((s, i) => (
          <li key={s.key} className={`flex items-center gap-1 ${i <= stepIndex ? 'text-blue-700' : 'text-slate-400'}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${i < stepIndex ? 'bg-blue-600 text-white' : i === stepIndex ? 'border-2 border-blue-600' : 'border border-slate-300'}`}>{i + 1}</span>
            <span className="hidden sm:inline">{s.label}</span>
            {i < STEPS.length - 1 && <span className="mx-1 text-slate-300">›</span>}
          </li>
        ))}
      </ol>

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="card p-5">
        {step === 'identify' && (
          <form onSubmit={(e) => { e.preventDefault(); void handleIdentify(); }} className="space-y-4">
            <div>
              <h1 className="text-lg font-bold text-slate-900">Let's find you</h1>
              <p className="text-sm text-slate-500">Enter the mobile number and licence plate we have on file. New customer? Enter them anyway — we'll set you up.</p>
            </div>
            <label className="block">
              <span className="input-label">Mobile number</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input-field" inputMode="tel" autoComplete="tel" placeholder="876-555-0100" required />
            </label>
            <label className="block">
              <span className="input-label">Licence plate</span>
              <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} className="input-field uppercase" placeholder="ABC1234" required />
            </label>
            <button type="submit" disabled={busy || !phone.trim() || !plate.trim()} className="btn-primary w-full disabled:opacity-50">{busy ? 'Checking…' : 'Continue'}</button>
          </form>
        )}

        {step === 'details' && (
          <div className="space-y-4">
            {identified?.known ? (
              <>
                <div>
                  <h1 className="text-lg font-bold text-slate-900">Welcome back, {identified.firstName}</h1>
                  <p className="text-sm text-slate-500">Mobile ending {identified.phoneMasked}. Which vehicle is this for?</p>
                </div>
                <div className="space-y-2">
                  {identified.vehicles?.map((v) => (
                    <label key={v.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${vehicleId === v.id && !addVehicle ? 'border-blue-600 bg-blue-50' : 'border-slate-200'}`}>
                      <input type="radio" name="vehicle" checked={vehicleId === v.id && !addVehicle} onChange={() => { setVehicleId(v.id); setAddVehicle(false); }} />
                      <span className="text-sm">
                        <span className="font-semibold text-slate-900">{[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle'}</span>
                        <span className="ml-2 font-mono text-xs text-slate-500">{v.plateMasked}</span>
                      </span>
                    </label>
                  ))}
                  <label className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${addVehicle ? 'border-blue-600 bg-blue-50' : 'border-slate-200'}`}>
                    <input type="radio" name="vehicle" checked={addVehicle} onChange={() => setAddVehicle(true)} />
                    <span className="text-sm font-semibold text-slate-900">A different vehicle</span>
                  </label>
                </div>
              </>
            ) : (
              <>
                <div>
                  <h1 className="text-lg font-bold text-slate-900">Tell us about you</h1>
                  <p className="text-sm text-slate-500">We didn't find that mobile and plate together, so we'll create a new record.</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block"><span className="input-label">First name</span><input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="input-field" required /></label>
                  <label className="block"><span className="input-label">Last name</span><input value={lastName} onChange={(e) => setLastName(e.target.value)} className="input-field" required /></label>
                </div>
                <label className="block"><span className="input-label">Email (optional)</span><input value={email} onChange={(e) => setEmail(e.target.value)} className="input-field" type="email" /></label>
                <div className="flex flex-wrap gap-4 text-sm text-slate-700">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={smsOptIn} onChange={(e) => setSmsOptIn(e.target.checked)} /> Text me updates</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={emailOptIn} onChange={(e) => setEmailOptIn(e.target.checked)} /> Email me updates</label>
                </div>
              </>
            )}

            {needsVehicleForm && (
              <div className="space-y-3 rounded-lg border border-slate-200 p-3">
                <p className="text-sm font-semibold text-slate-800">Vehicle</p>
                <label className="block"><span className="input-label">Licence plate</span><input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} className="input-field uppercase" required /></label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block"><span className="input-label">Make</span><input value={make} onChange={(e) => setMake(e.target.value)} className="input-field" placeholder="Toyota" /></label>
                  <label className="block"><span className="input-label">Model</span><input value={model} onChange={(e) => setModel(e.target.value)} className="input-field" placeholder="Corolla" /></label>
                  <label className="block"><span className="input-label">Year</span><input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} className="input-field" inputMode="numeric" placeholder="2019" /></label>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('identify')} className="btn-secondary">Back</button>
              <button type="button" disabled={!detailsValid()} onClick={() => setStep('service')} className="btn-primary flex-1 disabled:opacity-50">Continue</button>
            </div>
          </div>
        )}

        {step === 'service' && (
          <div className="space-y-4">
            <div>
              <h1 className="text-lg font-bold text-slate-900">What do you need?</h1>
              <p className="text-sm text-slate-500">Choose one or more services. We plan about {siteQ.data.plannedMinutes} minutes per appointment.</p>
            </div>
            {servicesQ.isLoading && <p className="text-sm text-slate-500">Loading services…</p>}
            <div className="max-h-80 space-y-1.5 overflow-y-auto">
              {servicesQ.data?.map((s) => {
                const on = codes.includes(s.code);
                return (
                  <label key={s.code} className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 ${on ? 'border-blue-600 bg-blue-50' : 'border-slate-200'}`}>
                    <span className="flex items-center gap-3">
                      <input type="checkbox" checked={on} onChange={() => setCodes((c) => (on ? c.filter((x) => x !== s.code) : [...c, s.code]))} />
                      <span className="text-sm font-medium text-slate-900">{s.name}</span>
                    </span>
                    {s.family && <span className="text-[11px] text-slate-400">{s.family}</span>}
                  </label>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('details')} className="btn-secondary">Back</button>
              <button type="button" disabled={codes.length === 0} onClick={() => { setSlot(null); setStep('slot'); }} className="btn-primary flex-1 disabled:opacity-50">See available times</button>
            </div>
          </div>
        )}

        {step === 'slot' && (
          <div className="space-y-4">
            <div>
              <h1 className="text-lg font-bold text-slate-900">Pick a time</h1>
              <p className="text-sm text-slate-500">Times are shown in the service centre's local time.</p>
            </div>
            {availabilityQ.isLoading && <p className="text-sm text-slate-500">Checking the schedule…</p>}
            {availabilityQ.isError && <p className="text-sm text-red-700">We could not load available times. Please try again.</p>}
            {availabilityQ.data && <SlotPicker data={availabilityQ.data} selected={slot} onSelect={setSlot} />}
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('service')} className="btn-secondary">Back</button>
              <button type="button" disabled={!slot} onClick={() => setStep('confirm')} className="btn-primary flex-1 disabled:opacity-50">Review booking</button>
            </div>
          </div>
        )}

        {step === 'confirm' && slot && (
          <div className="space-y-4">
            <div>
              <h1 className="text-lg font-bold text-slate-900">Please confirm</h1>
              <p className="text-sm text-slate-500">Nothing is reserved until you press Confirm.</p>
            </div>
            <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
              <Row label="Customer" value={identified?.known ? `${identified.firstName} · mobile ending ${identified.phoneMasked}` : `${firstName} ${lastName} · ${phone}`} />
              <Row label="Vehicle" value={needsVehicleForm ? `${[year, make, model].filter(Boolean).join(' ') || 'Vehicle'} · ${plate}` : `${describeVehicle(identified, vehicleId)}`} />
              <Row label="Service" value={(servicesQ.data ?? []).filter((s) => codes.includes(s.code)).map((s) => s.name).join(', ')} />
              <Row label="Date" value={fmtWhen(slot.startAt, tz).split(',').slice(0, 2).join(',')} />
              <Row label="Arrival time" value={fmtWhen(slot.startAt, tz).split(', ').pop() ?? ''} strong />
              <Row label="Expected service time" value={`About ${availabilityQ.data?.plannedMinutes ?? siteQ.data.plannedMinutes} minutes`} />
              <Row label="Service centre" value={siteQ.data.siteName} />
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{siteQ.data.arrivalInstructions}</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('slot')} className="btn-secondary" disabled={busy}>Back</button>
              <button type="button" onClick={() => void handleConfirm()} disabled={busy} className="btn-primary flex-1 disabled:opacity-50">{busy ? 'Reserving…' : 'Confirm appointment'}</button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}

function describeVehicle(identified: Identified | null, vehicleId: string | null): string {
  const v = identified?.vehicles?.find((x) => x.id === vehicleId);
  if (!v) return '—';
  return `${[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle'} · ${v.plateMasked}`;
}

function Row({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className={`text-right ${strong ? 'font-bold text-slate-900' : 'text-slate-800'}`}>
        {value}
        {sub && <span className="block font-mono text-xs text-slate-500">{sub}</span>}
      </span>
    </div>
  );
}
