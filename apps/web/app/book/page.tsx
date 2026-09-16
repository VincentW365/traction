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
  manageUrl?: string;
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
  /**
   * CR-2026-108 Stage 3 — an administrator-issued UAT session token, present only
   * when this page was opened from the Booking Simulator's launch link. Read from
   * the URL and passed through untouched; the server verifies the signature and
   * ignores anything it cannot verify, so a hand-typed value changes nothing. The
   * page is otherwise completely unchanged — this is the real customer flow.
   */
  const [uatToken, setUatToken] = useState('');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = new URLSearchParams(window.location.search).get('uat');
    if (t) setUatToken(t);
  }, []);

  // Step 1 — CR-2026-106: mobile + plate, or mobile + email (never name only)
  const [phone, setPhone] = useState('');
  const [plate, setPlate] = useState('');
  const [identifyBy, setIdentifyBy] = useState<'PLATE' | 'EMAIL'>('PLATE');
  const [identifyEmail, setIdentifyEmail] = useState('');
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
  // CR-2026-106 — what the workshop needs to prepare the Job Sheet (customer words, not a mechanic form)
  const [reasonForVisit, setReasonForVisit] = useState('');
  const [concern, setConcern] = useState('');
  const [description, setDescription] = useState('');
  const [mileage, setMileage] = useState('');
  // CR-2026-106 — "Later dates": the first day the availability window starts from
  const [fromKey, setFromKey] = useState<string | null>(null);
  const [done, setDone] = useState<Confirmation | null>(null);
  const [copied, setCopied] = useState(false);

  const siteQ = useQuery<SiteInfo>({ queryKey: ['public-site'], queryFn: () => publicApi.get('/public/booking/site'), retry: 3, retryDelay: 3000 });
  const servicesQ = useQuery<ServiceOption[]>({ queryKey: ['public-services'], queryFn: () => publicApi.get('/public/booking/services'), enabled: step !== 'identify' });
  const availabilityQ = useQuery<Availability>({
    queryKey: ['public-availability', codes.join(','), availabilityNonce, fromKey],
    queryFn: () => publicApi.get(`/public/booking/availability?serviceCodes=${encodeURIComponent(codes.join(','))}&days=14${fromKey ? `&from=${fromKey}` : ''}`),
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
      const res = await publicApi.post<Identified>(
        '/public/booking/identify',
        identifyBy === 'EMAIL' ? { phone: phone.trim(), email: identifyEmail.trim() } : { phone: phone.trim(), plateNumber: plate.trim() },
      );
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
        serviceRequest:
          reasonForVisit.trim() || concern.trim() || description.trim() || mileage.trim()
            ? {
                reasonForVisit: reasonForVisit.trim() || undefined,
                concern: concern.trim() || undefined,
                description: description.trim() || undefined,
                mileage: mileage.trim() ? Number(mileage.replace(/[^0-9]/g, '')) : undefined,
              }
            : undefined,
        // CR-2026-108 Stage 3 — an administrator-issued UAT session, if this page
        // was opened from the Booking Simulator. Passed straight through: the
        // server verifies the signature, and an invalid one is simply ignored, so
        // the booking then behaves as an ordinary real one.
        uatToken: uatToken || undefined,
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
      } else if (e instanceof PublicApiError && e.code === 'AFTER_LATEST_START') {
        // CR-2026-106 — the server enforces the latest start; a stale page could still
        // submit one. Back to the (refreshed) slots with the reason.
        setSlot(null);
        setAvailabilityNonce((n) => n + 1);
        setStep('slot');
        setError(e.message);
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
    // CR-2026-106 — the API builds this from PUBLIC_APP_URL; the browser origin is only a fallback.
    const manageUrl = done.manageUrl ?? (typeof window !== 'undefined' ? `${window.location.origin}${done.managePath}` : done.managePath);
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
              <p className="text-sm text-slate-500">Enter your mobile number plus the licence plate (or the email) we have on file. New customer? Enter your mobile and plate anyway — we'll set you up.</p>
            </div>
            <label className="block">
              <span className="input-label">Mobile number</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input-field" inputMode="tel" autoComplete="tel" placeholder="876-555-0100" required />
            </label>
            <div className="flex gap-2 text-xs" role="tablist" aria-label="Identify with">
              <button type="button" role="tab" aria-selected={identifyBy === 'PLATE'} onClick={() => setIdentifyBy('PLATE')} className={`min-h-9 rounded-md px-3 py-1.5 font-semibold ${identifyBy === 'PLATE' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'}`}>Licence plate</button>
              <button type="button" role="tab" aria-selected={identifyBy === 'EMAIL'} onClick={() => setIdentifyBy('EMAIL')} className={`min-h-9 rounded-md px-3 py-1.5 font-semibold ${identifyBy === 'EMAIL' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'}`}>Email on file</button>
            </div>
            {identifyBy === 'PLATE' ? (
              <label className="block">
                <span className="input-label">Licence plate</span>
                <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} className="input-field uppercase" placeholder="ABC1234" required />
              </label>
            ) : (
              <label className="block">
                <span className="input-label">Email on file</span>
                <input value={identifyEmail} onChange={(e) => setIdentifyEmail(e.target.value)} className="input-field" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" required />
              </label>
            )}
            <button type="submit" disabled={busy || !phone.trim() || (identifyBy === 'PLATE' ? !plate.trim() : !identifyEmail.trim())} className="btn-primary min-h-11 w-full disabled:opacity-50">{busy ? 'Checking…' : 'Continue'}</button>
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
            {/* CR-2026-106 — the facts the workshop needs to prepare the Job Sheet, in the customer's words */}
            <div className="space-y-3 rounded-lg border border-slate-200 p-3" data-testid="service-request">
              <p className="text-sm font-semibold text-slate-800">Tell us a little more <span className="font-normal text-slate-500">(optional, helps us prepare)</span></p>
              <label className="block">
                <span className="input-label">Reason for visit</span>
                <select value={reasonForVisit} onChange={(e) => setReasonForVisit(e.target.value)} className="input-field min-h-11">
                  <option value="">Choose…</option>
                  <option>Routine service</option>
                  <option>Warning light on</option>
                  <option>Noise or vibration</option>
                  <option>Brakes</option>
                  <option>Leak</option>
                  <option>Pre-purchase / inspection</option>
                  <option>Something else</option>
                </select>
              </label>
              <label className="block">
                <span className="input-label">Main concern</span>
                <input value={concern} onChange={(e) => setConcern(e.target.value.slice(0, 500))} className="input-field min-h-11" placeholder="e.g. squeal when braking at low speed" />
              </label>
              <label className="block">
                <span className="input-label">Anything else we should know</span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 1000))} className="input-field" rows={2} />
              </label>
              <label className="block">
                <span className="input-label">Current mileage (km or miles as shown)</span>
                <input value={mileage} onChange={(e) => setMileage(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))} className="input-field min-h-11" inputMode="numeric" placeholder="e.g. 84500" />
              </label>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('details')} className="btn-secondary min-h-11">Back</button>
              <button type="button" disabled={codes.length === 0} onClick={() => { setSlot(null); setStep('slot'); }} className="btn-primary min-h-11 flex-1 disabled:opacity-50">See available times</button>
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
            {availabilityQ.data?.range && (
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setSlot(null); setFromKey(null); }} disabled={!fromKey} className="btn-secondary min-h-9 px-3 py-1 text-xs disabled:opacity-50">← From today</button>
                <button type="button" onClick={() => { setSlot(null); setFromKey(nextDayKey(availabilityQ.data!.range!.to)); }} className="btn-secondary min-h-9 px-3 py-1 text-xs">Later dates →</button>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('service')} className="btn-secondary min-h-11">Back</button>
              <button type="button" disabled={!slot} onClick={() => setStep('confirm')} className="btn-primary min-h-11 flex-1 disabled:opacity-50">Review booking</button>
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
              {reasonForVisit.trim() && <Row label="Reason" value={reasonForVisit.trim()} />}
              {concern.trim() && <Row label="Your concern" value={concern.trim()} />}
              {mileage.trim() && <Row label="Mileage" value={Number(mileage).toLocaleString('en-US')} />}
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

/** The day after a YYYY-MM-DD key (calendar arithmetic). */
function nextDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
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
