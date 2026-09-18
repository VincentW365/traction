'use client';

/**
 * CR-2026-111 — public booking as the Job Sheet's intake layer.
 *
 * Customer → Vehicle → Service → Details → Appointment → Review. Everything the
 * customer types here lands on the same Appointment record staff use, and reaches
 * the Job Sheet without anybody retyping it.
 *
 * Two rules shape the design:
 *
 *  1. The customer is asked for each fact ONCE. A plate typed to identify becomes
 *     the plate on the vehicle; the category they pick becomes the reason for the
 *     visit; the mileage they read off the dashboard becomes the Job Sheet's
 *     mileage. Asking twice is how a form teaches people to stop answering.
 *
 *  2. Going back never costs them their answers. Changing a step invalidates only
 *     what genuinely depends on it — a different service can change how long the
 *     appointment needs, so the time is released and the customer is TOLD why;
 *     rewording a concern cannot, so the time stands.
 *
 * Privacy is unchanged from CR-2026-105c: this page never sees a full plate, a
 * full phone number, or another customer's data. The API masks them.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PublicApiError, fmtWhen, publicApi } from '../../lib/public-api';
import { SlotPicker, type Availability, type Slot } from './slot-picker';
import {
  BOOKING_CATEGORIES,
  concernRequired,
  findCategory,
  resolveServiceCodes,
  schedulingChanged,
  type BookingCategory,
} from '../../lib/booking-categories';

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

type Step = 'customer' | 'vehicle' | 'service' | 'details' | 'appointment' | 'review' | 'done';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'customer', label: 'Customer' },
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'service', label: 'Service' },
  { key: 'details', label: 'Details' },
  { key: 'appointment', label: 'Appointment' },
  { key: 'review', label: 'Review' },
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
  const [step, setStep] = useState<Step>('customer');
  const [error, setError] = useState<string | null>(null);

  /**
   * CR-2026-108 Stage 3 — UAT launch exchange.
   *
   * A launch token appears in the URL for exactly ONE request. It is redeemed
   * immediately for an HttpOnly cookie the page cannot read, and the URL is then
   * replaced with a clean /book, so the privileged token never reaches browser
   * history, bookmarks, referrers or a screenshot.
   *
   * If the exchange FAILS the booking is blocked, never downgraded. A tester
   * holding an expired link must not sail on and create a real customer who then
   * receives a real message and lands in operational reporting.
   */
  const [uatState, setUatState] = useState<'none' | 'exchanging' | 'active' | 'failed'>('none');
  const [uatRunLabel, setUatRunLabel] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = new URLSearchParams(window.location.search).get('uat');
    if (!token) return;
    setUatState('exchanging');
    publicApi
      .post<{ runLabel: string }>('/public/booking/uat/redeem', { token })
      .then((r) => { setUatRunLabel(r.runLabel); setUatState('active'); })
      .catch(() => setUatState('failed'))
      .finally(() => {
        // Clean the address bar either way — a spent or dead token has no business
        // lingering in history, bookmarks, referrers or a screenshot.
        window.history.replaceState({}, '', '/book');
      });
  }, []);

  // --- Step 1: Customer -----------------------------------------------------
  // CR-2026-106: mobile + plate, or mobile + email. Never name only.
  const [phone, setPhone] = useState('');
  const [plate, setPlate] = useState('');
  const [identifyBy, setIdentifyBy] = useState<'PLATE' | 'EMAIL'>('PLATE');
  const [identifyEmail, setIdentifyEmail] = useState('');
  const [identified, setIdentified] = useState<Identified | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(true);
  const [emailOptIn, setEmailOptIn] = useState(true);
  const [busy, setBusy] = useState(false);

  // --- Step 2: Vehicle ------------------------------------------------------
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [addVehicle, setAddVehicle] = useState(false);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');

  // --- Step 3: Service ------------------------------------------------------
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [optionKey, setOptionKey] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);

  // --- Step 4: Details ------------------------------------------------------
  const [mileage, setMileage] = useState('');
  const [concern, setConcern] = useState('');
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [description, setDescription] = useState('');

  // --- Step 5: Appointment --------------------------------------------------
  const [slot, setSlot] = useState<Slot | null>(null);
  const [availabilityNonce, setAvailabilityNonce] = useState(0);
  const [fromKey, setFromKey] = useState<string | null>(null);
  /**
   * §9 — why a chosen time was released.
   *
   * Silently clearing the time is the worst outcome: the customer reaches Review,
   * finds no appointment, and cannot tell whether the system lost it or they never
   * picked one. This says which earlier change released it, in their words.
   */
  const [slotReleased, setSlotReleased] = useState<string | null>(null);

  const [done, setDone] = useState<Confirmation | null>(null);
  const [copied, setCopied] = useState(false);

  const siteQ = useQuery<SiteInfo>({ queryKey: ['public-site'], queryFn: () => publicApi.get('/public/booking/site'), retry: 3, retryDelay: 3000 });
  const servicesQ = useQuery<ServiceOption[]>({ queryKey: ['public-services'], queryFn: () => publicApi.get('/public/booking/services'), enabled: step !== 'customer' });

  const isNew = identified ? !identified.known : true;
  const needsVehicleForm = isNew || addVehicle;
  const tz = siteQ.data?.timezone;
  // An existing vehicle lets the server resolve the class, and therefore the real
  // length (General Servicing is 90 minutes for a sedan, 120 for an SUV). A vehicle
  // being added has no class yet and plans at the base duration.
  const quoteVehicleId = !needsVehicleForm ? vehicleId : null;

  const availabilityQ = useQuery<Availability>({
    queryKey: ['public-availability', codes.join(','), availabilityNonce, fromKey, quoteVehicleId],
    queryFn: () =>
      publicApi.get(
        `/public/booking/availability?serviceCodes=${encodeURIComponent(codes.join(','))}&days=14` +
          (fromKey ? `&from=${fromKey}` : '') +
          (quoteVehicleId ? `&vehicleId=${encodeURIComponent(quoteVehicleId)}` : ''),
      ),
    enabled: (step === 'appointment' || step === 'review') && codes.length > 0,
    staleTime: 20000,
  });

  useEffect(() => setError(null), [step]);

  const category = categoryKey ? findCategory(categoryKey) : undefined;
  const concernNeeded = categoryKey ? concernRequired(categoryKey, optionKey) : false;

  /**
   * Only offer what can actually be booked.
   *
   * A card whose services are not live online would take the customer all the way
   * to Review and fail at the last step. So the catalogue the API returns decides
   * which cards exist: a service approved but not yet activated simply is not
   * offered, and activating it makes the card appear with no code change.
   */
  const visibleCategories = useMemo<BookingCategory[]>(() => {
    const bookable = new Set((servicesQ.data ?? []).map((s) => s.code));
    if (bookable.size === 0) return [];
    const out: BookingCategory[] = [];
    for (const c of BOOKING_CATEGORIES) {
      if (!c.options || c.options.length === 0) {
        if (c.serviceCodes.length > 0 && c.serviceCodes.every((x) => bookable.has(x))) out.push(c);
        continue;
      }
      const options = c.options.filter((o) => resolveServiceCodes(c.key, o.key).every((x) => bookable.has(x)));
      if (options.length > 0) out.push({ ...c, options });
    }
    return out;
  }, [servicesQ.data]);

  /**
   * Last resort. If no card can be offered — a renamed code, a catalogue mid-edit —
   * the customer still gets the plain service list rather than a page that cannot
   * book anything. A booking page with nothing on it is an outage.
   */
  const useRawServiceList = visibleCategories.length === 0 && (servicesQ.data?.length ?? 0) > 0;

  // --- dependency-aware invalidation (§9) -----------------------------------

  /** Release the chosen time, and say which change released it. */
  function releaseSlot(because: string) {
    if (!slot) return;
    setSlotReleased(`The ${fmtWhen(slot.startAt, tz)} appointment you picked has been released because ${because}. Please choose a time again.`);
    setSlot(null);
  }

  /** Apply a new set of service codes, releasing the time only if the length can change. */
  function applyCodes(next: string[]) {
    if (schedulingChanged(codes, next)) releaseSlot('the service you chose takes a different amount of time');
    setCodes(next);
  }

  function chooseCategory(c: BookingCategory) {
    if (c.key === categoryKey) return;
    setCategoryKey(c.key);
    setOptionKey(null);
    // Symptoms belong to the category that offered them. Carrying "Noise when
    // braking" into a battery booking would put a false observation on the Job Sheet.
    setSymptoms([]);
    applyCodes(c.options && c.options.length > 0 ? [] : resolveServiceCodes(c.key, null));
  }

  function chooseOption(c: BookingCategory, key: string) {
    setOptionKey(key);
    applyCodes(resolveServiceCodes(c.key, key));
  }

  function chooseVehicle(id: string | null, addNew: boolean) {
    if (id === vehicleId && addNew === addVehicle) return;
    setVehicleId(id);
    setAddVehicle(addNew);
    // A different vehicle can be a different class, and therefore a different
    // length. The server decides that; the page cannot, so it re-asks.
    releaseSlot('you changed the vehicle');
  }

  async function handleIdentify() {
    setBusy(true);
    setError(null);
    try {
      const res = await publicApi.post<Identified>(
        '/public/booking/identify',
        identifyBy === 'EMAIL' ? { phone: phone.trim(), email: identifyEmail.trim() } : { phone: phone.trim(), plateNumber: plate.trim() },
      );
      // A different customer has different vehicles, so the vehicle choice cannot
      // survive. The service and the details can: they wanted the same work either way.
      setIdentified(res);
      if (res.known) {
        const matched = res.vehicles?.find((v) => v.matched) ?? res.vehicles?.[0];
        setVehicleId(matched?.id ?? null);
        setAddVehicle(false);
      } else {
        setVehicleId(null);
        setAddVehicle(true);
      }
      releaseSlot('your details changed');
      setStep('vehicle');
    } catch (e) {
      setError(e instanceof PublicApiError ? e.message : 'We could not reach the service centre. Please try again in a moment.');
    } finally {
      setBusy(false);
    }
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
        serviceRequest: {
          // The card they chose IS the reason for the visit. Asking again in a
          // separate "reason" dropdown would be asking the same question twice.
          reasonForVisit: category?.title,
          concern: concern.trim() || undefined,
          description: description.trim() || undefined,
          mileage: mileage.trim() ? Number(mileage.replace(/[^0-9]/g, '')) : undefined,
          category: categoryKey ?? undefined,
          symptoms: symptoms.length > 0 ? symptoms : undefined,
        },
      };
      const res = await publicApi.post<Confirmation>('/public/booking/confirm', body);
      setDone(res);
      setStep('done');
    } catch (e) {
      if (e instanceof PublicApiError && e.code === 'SLOT_TAKEN') {
        setSlot(null);
        setAvailabilityNonce((n) => n + 1);
        setStep('appointment');
        setError('Sorry — that time was just taken. Here are the current openings.');
      } else if (e instanceof PublicApiError && e.code === 'AFTER_LATEST_START') {
        // CR-2026-106 — the server enforces the latest start; a stale page could still
        // submit one. Back to the (refreshed) slots with the reason.
        setSlot(null);
        setAvailabilityNonce((n) => n + 1);
        setStep('appointment');
        setError(e.message);
      } else if (e instanceof PublicApiError && e.status === 403) {
        setIdentified(null);
        setStep('customer');
        setError(e.message);
      } else {
        setError(e instanceof PublicApiError ? e.message : 'We could not complete the booking. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  // --- step completion, which drives the clickable stepper -------------------

  const complete: Record<Step, boolean> = {
    customer: !!identified && (identified.known || (!!firstName.trim() && !!lastName.trim())),
    vehicle: needsVehicleForm ? !!plate.trim() : !!vehicleId,
    service: codes.length > 0,
    details: codes.length > 0 && (!concernNeeded || !!concern.trim()),
    appointment: !!slot,
    review: false,
    done: false,
  };

  /** A step is reachable once everything it depends on is answered. */
  function canVisit(target: Step): boolean {
    const i = STEPS.findIndex((s) => s.key === target);
    if (i < 0) return false;
    return STEPS.slice(0, i).every((s) => complete[s.key]);
  }

  function goTo(target: Step) {
    if (canVisit(target)) setStep(target);
  }

  // CR-2026-108 Stage 3 — a UAT launch that did not redeem BLOCKS the flow. It is
  // deliberately not downgraded into an ordinary booking: someone who followed a
  // test link believes nothing real is happening, and letting them continue would
  // create a real customer, send them a real message and contaminate reporting.
  // The wording says what to do and nothing about tokens or cryptography.
  if (uatState === 'exchanging') {
    return (
      <Shell>
        <div className="card p-6 text-center text-sm text-slate-500">Starting the test booking session…</div>
      </Shell>
    );
  }
  if (uatState === 'failed') {
    return (
      <Shell>
        <div className="card p-6 space-y-3 text-center">
          <p className="text-sm font-semibold text-slate-900">This test booking session is invalid or has expired.</p>
          <p className="text-sm text-slate-600">Return to the Booking Simulator and start a new UAT session.</p>
          <p className="text-xs text-slate-500">If you meant to book a real appointment, open the booking page normally.</p>
          <a href="/book" className="btn btn-secondary inline-block">Book a real appointment</a>
        </div>
      </Shell>
    );
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
        <div className="card overflow-hidden" data-testid="booking-confirmed">
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
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">You will not be asked for this again</p>
              <p className="mt-1 text-sm">
                What you told us is already on the job sheet for your vehicle. When you arrive, the service advisor will have it in front of them.
              </p>
            </div>
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
      {/* CR-2026-108 — a UAT session must be unmistakable. A tester who cannot tell
          whether they are in one is exactly how a real customer gets contacted. */}
      {uatState === 'active' && (
        <div className="mb-4 rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-xs text-violet-900">
          <span className="font-semibold">Test booking session</span>
          {uatRunLabel ? <span className="font-mono"> · {uatRunLabel}</span> : null}
          <span className="block text-violet-800">
            Nothing here reaches a real customer: records are marked as test data and messages are recorded instead of sent.
          </span>
        </div>
      )}

      <Stepper current={step} stepIndex={stepIndex} canVisit={canVisit} complete={complete} onGo={goTo} />

      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {slotReleased && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="slot-released">
          <span aria-hidden className="mt-0.5 font-bold">!</span>
          <span className="flex-1">{slotReleased}</span>
          <button type="button" onClick={() => setSlotReleased(null)} className="shrink-0 text-amber-700 underline" aria-label="Dismiss">Got it</button>
        </div>
      )}

      <div className="card p-5">
        {/* ---------------------------------------------------------------- 1 */}
        {step === 'customer' && (
          <form onSubmit={(e) => { e.preventDefault(); void handleIdentify(); }} className="space-y-4">
            <StepHeading
              title="Let's find you"
              subtitle="Enter your mobile number plus the licence plate (or the email) we have on file. New customer? Enter your mobile and plate anyway — we'll set you up."
            />
            <label className="block">
              <span className="input-label">Mobile number</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input-field min-h-12" inputMode="tel" autoComplete="tel" placeholder="876-555-0100" required />
            </label>
            <div className="flex gap-2 text-xs" role="tablist" aria-label="Identify with">
              <button type="button" role="tab" aria-selected={identifyBy === 'PLATE'} onClick={() => setIdentifyBy('PLATE')} className={`min-h-11 rounded-md px-3 py-1.5 font-semibold ${identifyBy === 'PLATE' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'}`}>Licence plate</button>
              <button type="button" role="tab" aria-selected={identifyBy === 'EMAIL'} onClick={() => setIdentifyBy('EMAIL')} className={`min-h-11 rounded-md px-3 py-1.5 font-semibold ${identifyBy === 'EMAIL' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'}`}>Email on file</button>
            </div>
            {identifyBy === 'PLATE' ? (
              <label className="block">
                <span className="input-label">Licence plate</span>
                <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} className="input-field min-h-12 uppercase" placeholder="ABC1234" required />
              </label>
            ) : (
              <label className="block">
                <span className="input-label">Email on file</span>
                <input value={identifyEmail} onChange={(e) => setIdentifyEmail(e.target.value)} className="input-field min-h-12" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" required />
              </label>
            )}
            <ActionBar>
              <button type="submit" disabled={busy || !phone.trim() || (identifyBy === 'PLATE' ? !plate.trim() : !identifyEmail.trim())} className="btn-primary min-h-12 w-full disabled:opacity-50">
                {busy ? 'Checking…' : 'Continue'}
              </button>
            </ActionBar>
          </form>
        )}

        {/* ---------------------------------------------------------------- 2 */}
        {step === 'vehicle' && (
          <div className="space-y-4">
            {identified?.known ? (
              <>
                <StepHeading title={`Welcome back, ${identified.firstName}`} subtitle={`Mobile ending ${identified.phoneMasked}. Which vehicle is this for?`} />
                <div className="space-y-2">
                  {identified.vehicles?.map((v) => (
                    <label key={v.id} className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-3 ${vehicleId === v.id && !addVehicle ? 'border-blue-600 bg-blue-50' : 'border-slate-200'}`}>
                      <input type="radio" name="vehicle" className="h-5 w-5" checked={vehicleId === v.id && !addVehicle} onChange={() => chooseVehicle(v.id, false)} />
                      <span className="text-sm">
                        <span className="font-semibold text-slate-900">{[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle'}</span>
                        <span className="ml-2 font-mono text-xs text-slate-500">{v.plateMasked}</span>
                      </span>
                    </label>
                  ))}
                  <label className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-3 ${addVehicle ? 'border-blue-600 bg-blue-50' : 'border-slate-200'}`}>
                    <input type="radio" name="vehicle" className="h-5 w-5" checked={addVehicle} onChange={() => chooseVehicle(null, true)} />
                    <span className="text-sm font-semibold text-slate-900">A different vehicle</span>
                  </label>
                </div>
              </>
            ) : (
              <>
                <StepHeading title="Tell us about you and the vehicle" subtitle="We didn't find that mobile and plate together, so we'll set up a new record." />
                <div className="grid grid-cols-2 gap-3">
                  <label className="block"><span className="input-label">First name</span><input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="input-field min-h-12" autoComplete="given-name" required /></label>
                  <label className="block"><span className="input-label">Last name</span><input value={lastName} onChange={(e) => setLastName(e.target.value)} className="input-field min-h-12" autoComplete="family-name" required /></label>
                </div>
                <label className="block"><span className="input-label">Email (optional)</span><input value={email} onChange={(e) => setEmail(e.target.value)} className="input-field min-h-12" type="email" inputMode="email" autoComplete="email" /></label>
                <div className="flex flex-wrap gap-x-4 text-sm text-slate-700">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={smsOptIn} onChange={(e) => setSmsOptIn(e.target.checked)} /> Text me updates</label>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={emailOptIn} onChange={(e) => setEmailOptIn(e.target.checked)} /> Email me updates</label>
                </div>
              </>
            )}

            {needsVehicleForm && (
              <div className="space-y-3 rounded-lg border border-slate-200 p-3">
                <p className="text-sm font-semibold text-slate-800">Vehicle</p>
                <label className="block"><span className="input-label">Licence plate</span><input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} className="input-field min-h-12 uppercase" required /></label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block"><span className="input-label">Make</span><input value={make} onChange={(e) => setMake(e.target.value)} className="input-field min-h-12" placeholder="Toyota" /></label>
                  <label className="block"><span className="input-label">Model</span><input value={model} onChange={(e) => setModel(e.target.value)} className="input-field min-h-12" placeholder="Corolla" /></label>
                  <label className="block"><span className="input-label">Year</span><input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} className="input-field min-h-12" inputMode="numeric" placeholder="2019" /></label>
                </div>
              </div>
            )}

            <ActionBar>
              <button type="button" onClick={() => setStep('customer')} className="btn-secondary min-h-12">Back</button>
              <button type="button" disabled={!complete.vehicle} onClick={() => setStep('service')} className="btn-primary min-h-12 flex-1 disabled:opacity-50">Continue</button>
            </ActionBar>
          </div>
        )}

        {/* ---------------------------------------------------------------- 3 */}
        {step === 'service' && (
          <div className="space-y-4">
            <StepHeading title="What do you need?" subtitle="Choose the one that fits best. Not sure? Pick the last option and tell us what's happening." />
            {servicesQ.isLoading && <p className="text-sm text-slate-500">Loading services…</p>}

            {useRawServiceList ? (
              <div className="space-y-1.5" data-testid="service-fallback-list">
                {servicesQ.data?.map((s) => {
                  const on = codes.includes(s.code);
                  return (
                    <label key={s.code} className={`flex min-h-14 cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 ${on ? 'border-blue-600 bg-blue-50' : 'border-slate-200'}`}>
                      <span className="flex items-center gap-3">
                        <input type="checkbox" className="h-5 w-5" checked={on} onChange={() => applyCodes(on ? codes.filter((x) => x !== s.code) : [...codes, s.code])} />
                        <span className="text-sm font-medium text-slate-900">{s.name}</span>
                      </span>
                      {s.family && <span className="text-[11px] text-slate-400">{s.family}</span>}
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="service-categories">
                {visibleCategories.map((c) => {
                  const on = c.key === categoryKey;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      data-testid={`category-${c.key}`}
                      onClick={() => chooseCategory(c)}
                      aria-pressed={on}
                      className={`flex min-h-20 items-start gap-3 rounded-xl border p-3 text-left transition ${on ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                    >
                      <CatIcon kind={c.icon} active={on} />
                      <span className="flex-1">
                        <span className="block text-sm font-semibold text-slate-900">{c.title}</span>
                        <span className="mt-0.5 block text-xs leading-snug text-slate-500">{c.description}</span>
                        {c.approxMinutes && <span className="mt-1 block text-[11px] font-medium text-slate-400">About {c.approxMinutes} minutes</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* A category with meaningfully different intents asks one more question,
                here rather than on its own step: it is the same decision. */}
            {category?.options && category.options.length > 0 && (
              <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3" data-testid="category-options">
                <p className="text-sm font-semibold text-slate-800">{category.title} — which of these?</p>
                {category.options.map((o) => (
                  <label key={o.key} className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-lg border bg-white p-3 ${optionKey === o.key ? 'border-blue-600 ring-1 ring-blue-600' : 'border-slate-200'}`}>
                    <input type="radio" name="category-option" className="mt-0.5 h-5 w-5" checked={optionKey === o.key} onChange={() => chooseOption(category, o.key)} />
                    <span>
                      <span className="block text-sm font-medium text-slate-900">{o.label}</span>
                      {o.help && <span className="mt-0.5 block text-xs text-slate-500">{o.help}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}

            <ActionBar>
              <button type="button" onClick={() => setStep('vehicle')} className="btn-secondary min-h-12">Back</button>
              <button type="button" disabled={!complete.service} onClick={() => setStep('details')} className="btn-primary min-h-12 flex-1 disabled:opacity-50">Continue</button>
            </ActionBar>
          </div>
        )}

        {/* ---------------------------------------------------------------- 4 */}
        {step === 'details' && (
          <div className="space-y-4" data-testid="details-step">
            <StepHeading title="A few details" subtitle="This goes straight to the job sheet, so you won't be asked again when you arrive." />

            <label className="block">
              <span className="input-label">Current mileage <span className="font-normal text-slate-400">(as shown on your dashboard)</span></span>
              <input
                value={mileage}
                onChange={(e) => setMileage(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))}
                className="input-field min-h-12"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="e.g. 84500"
                data-testid="mileage"
              />
            </label>

            <label className="block">
              <span className="input-label">
                What would you like us to check or service?
                {concernNeeded && <span className="ml-1 text-red-600">*</span>}
              </span>
              <textarea
                value={concern}
                onChange={(e) => setConcern(e.target.value.slice(0, 500))}
                className="input-field"
                rows={3}
                data-testid="concern"
                placeholder={concernNeeded ? "Tell us what the vehicle is doing — in your own words." : 'Optional. Anything specific you want looked at.'}
                required={concernNeeded}
              />
              {concernNeeded && !concern.trim() && (
                <span className="mt-1 block text-xs text-slate-500">We need this to know what to look at when the vehicle arrives.</span>
              )}
            </label>

            {/* Conditional symptom questions — only for categories where a symptom is
                meaningful. These are INTAKE, not a diagnosis: nothing downstream may
                read a ticked box as a finding. */}
            {category?.symptoms && category.symptoms.length > 0 && (
              <fieldset className="rounded-lg border border-slate-200 p-3" data-testid="symptoms">
                <legend className="px-1 text-sm font-semibold text-slate-800">Have you noticed any of these?</legend>
                <p className="mb-2 text-xs text-slate-500">Tick any that apply. It helps us prepare — we'll still check the vehicle ourselves.</p>
                <div className="space-y-1">
                  {category.symptoms.map((s) => {
                    const on = symptoms.includes(s.code);
                    return (
                      <label key={s.code} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 text-sm text-slate-800">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          checked={on}
                          data-testid={`symptom-${s.code}`}
                          onChange={() => setSymptoms((cur) => (on ? cur.filter((x) => x !== s.code) : [...cur, s.code]))}
                        />
                        {s.label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}

            <label className="block">
              <span className="input-label">Anything else we should know? <span className="font-normal text-slate-400">(optional)</span></span>
              <textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 1000))} className="input-field" rows={2} data-testid="comments" />
            </label>

            <ActionBar>
              <button type="button" onClick={() => setStep('service')} className="btn-secondary min-h-12">Back</button>
              <button type="button" disabled={!complete.details} onClick={() => setStep('appointment')} className="btn-primary min-h-12 flex-1 disabled:opacity-50">See available times</button>
            </ActionBar>
          </div>
        )}

        {/* ---------------------------------------------------------------- 5 */}
        {step === 'appointment' && (
          <div className="space-y-4">
            <StepHeading title="Pick a time" subtitle="Times are shown in the service centre's local time." />
            {availabilityQ.isLoading && <p className="text-sm text-slate-500">Checking the schedule…</p>}
            {availabilityQ.isError && <p className="text-sm text-red-700">We could not load available times. Please try again.</p>}
            {availabilityQ.data && <SlotPicker data={availabilityQ.data} selected={slot} onSelect={(s) => { setSlot(s); setSlotReleased(null); }} />}
            {availabilityQ.data?.range && (
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setSlot(null); setFromKey(null); }} disabled={!fromKey} className="btn-secondary min-h-10 px-3 py-1 text-xs disabled:opacity-50">← From today</button>
                <button type="button" onClick={() => { setSlot(null); setFromKey(nextDayKey(availabilityQ.data!.range!.to)); }} className="btn-secondary min-h-10 px-3 py-1 text-xs">Later dates →</button>
              </div>
            )}
            <ActionBar>
              <button type="button" onClick={() => setStep('details')} className="btn-secondary min-h-12">Back</button>
              <button type="button" disabled={!slot} onClick={() => setStep('review')} className="btn-primary min-h-12 flex-1 disabled:opacity-50">Review booking</button>
            </ActionBar>
          </div>
        )}

        {/* ---------------------------------------------------------------- 6 */}
        {step === 'review' && (
          <div className="space-y-4" data-testid="review-step">
            <StepHeading title="Please confirm" subtitle="Nothing is reserved until you press Confirm. You can change anything below." />

            <ReviewSection title="Customer" onEdit={() => setStep('customer')}>
              <Row label="Name" value={identified?.known ? (identified.firstName ?? '—') : `${firstName} ${lastName}`.trim() || '—'} />
              <Row label="Mobile" value={identified?.known ? `ending ${identified.phoneMasked}` : phone} />
              {!identified?.known && email.trim() ? <Row label="Email" value={email.trim()} /> : null}
            </ReviewSection>

            <ReviewSection title="Vehicle" onEdit={() => setStep('vehicle')}>
              {(() => {
                if (!needsVehicleForm) return <Row label="Vehicle" value={describeVehicle(identified, vehicleId)} />;
                // Make and model are optional. When they gave neither, the plate IS
                // the description — showing the word "Vehicle" above it tells them
                // nothing and reads like something went wrong.
                const described = [year, make, model].filter(Boolean).join(' ');
                return described ? <Row label="Vehicle" value={described} sub={plate} /> : <Row label="Licence plate" value={plate} />;
              })()}
            </ReviewSection>

            <ReviewSection title="Service" onEdit={() => setStep('service')}>
              <Row label="You chose" value={category?.title ?? 'Service'} />
              {optionKey && category?.options ? <Row label="Specifically" value={category.options.find((o) => o.key === optionKey)?.label ?? '—'} /> : null}
              <Row label="We will book" value={(servicesQ.data ?? []).filter((s) => codes.includes(s.code)).map((s) => s.name).join(', ') || codes.join(', ')} />
            </ReviewSection>

            <ReviewSection title="Details" onEdit={() => setStep('details')}>
              {mileage.trim() ? <Row label="Mileage" value={Number(mileage).toLocaleString('en-US')} /> : null}
              {concern.trim() ? <Row label="Your request" value={concern.trim()} /> : null}
              {symptoms.length > 0 && category?.symptoms ? (
                <Row label="You noticed" value={category.symptoms.filter((s) => symptoms.includes(s.code)).map((s) => s.label).join(', ')} />
              ) : null}
              {description.trim() ? <Row label="Also" value={description.trim()} /> : null}
              {!mileage.trim() && !concern.trim() && symptoms.length === 0 && !description.trim() ? (
                <p className="text-sm text-slate-400">Nothing added.</p>
              ) : null}
            </ReviewSection>

            <ReviewSection title="Appointment" onEdit={() => setStep('appointment')}>
              {slot ? (
                <>
                  <Row label="Date" value={fmtWhen(slot.startAt, tz).split(',').slice(0, 2).join(',')} />
                  <Row label="Arrival time" value={fmtWhen(slot.startAt, tz).split(', ').pop() ?? ''} strong />
                  <Row label="Expected service time" value={`About ${availabilityQ.data?.plannedMinutes ?? siteQ.data.plannedMinutes} minutes`} />
                </>
              ) : (
                <p className="text-sm text-amber-700">No time chosen yet — pick one before confirming.</p>
              )}
              <Row label="Service centre" value={siteQ.data.siteName} />
            </ReviewSection>

            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{siteQ.data.arrivalInstructions}</div>

            <ActionBar>
              <button type="button" onClick={() => setStep('appointment')} className="btn-secondary min-h-12" disabled={busy}>Back</button>
              <button type="button" onClick={() => void handleConfirm()} disabled={busy || !slot} className="btn-primary min-h-12 flex-1 disabled:opacity-50" data-testid="confirm">
                {busy ? 'Reserving…' : 'Confirm appointment'}
              </button>
            </ActionBar>
          </div>
        )}
      </div>
    </Shell>
  );
}

/**
 * The progress stepper. A completed step is a BUTTON, because the customer is
 * allowed to go back and change it; a step they have not earned yet is inert.
 * On a phone only the current step is named — six labels across 375px is a smear.
 */
function Stepper({
  current,
  stepIndex,
  canVisit,
  complete,
  onGo,
}: {
  current: Step;
  stepIndex: number;
  canVisit: (s: Step) => boolean;
  complete: Record<Step, boolean>;
  onGo: (s: Step) => void;
}) {
  return (
    <nav aria-label="Booking progress" className="mb-4">
      <ol className="flex items-center gap-1">
        {STEPS.map((s, i) => {
          const isCurrent = s.key === current;
          const reachable = canVisit(s.key) && !isCurrent;
          const isDone = complete[s.key] && i < stepIndex;
          return (
            <li key={s.key} className="flex flex-1 items-center gap-1">
              <button
                type="button"
                onClick={() => reachable && onGo(s.key)}
                disabled={!reachable}
                aria-current={isCurrent ? 'step' : undefined}
                data-testid={`step-${s.key}`}
                className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-1 text-[11px] font-semibold uppercase tracking-wider transition ${
                  isCurrent ? 'text-blue-700' : reachable ? 'text-slate-600 hover:bg-slate-100' : 'cursor-default text-slate-400'
                }`}
                title={reachable ? `Go back to ${s.label}` : s.label}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] ${
                    isDone ? 'bg-blue-600 text-white' : isCurrent ? 'border-2 border-blue-600 text-blue-700' : 'border border-slate-300'
                  }`}
                >
                  {isDone ? '✓' : i + 1}
                </span>
                <span className={isCurrent ? 'inline' : 'hidden sm:inline'}>{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1 className="text-lg font-bold text-slate-900">{title}</h1>
      <p className="text-sm text-slate-500">{subtitle}</p>
    </div>
  );
}

/** Sticky on a phone, so Continue is always in reach of a thumb. */
function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-5 -mb-5 flex gap-2 border-t border-slate-200 bg-white/95 px-5 py-3 backdrop-blur">
      {children}
    </div>
  );
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200">
      <header className="flex items-center justify-between border-b border-slate-100 py-1 pl-3 pr-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
        {/* Edit is the whole point of the review step, so it gets a real target
            rather than a 16px text link a thumb has to hunt for. */}
        <button
          type="button"
          onClick={onEdit}
          className="min-h-11 rounded-md px-3 text-xs font-semibold text-blue-700 underline hover:bg-blue-50"
          data-testid={`edit-${title.toLowerCase()}`}
        >
          Edit
        </button>
      </header>
      <div className="space-y-2 px-3 py-2.5 text-sm">{children}</div>
    </section>
  );
}

function CatIcon({ kind, active }: { kind: BookingCategory['icon']; active: boolean }) {
  const cls = `h-6 w-6 shrink-0 ${active ? 'text-blue-600' : 'text-slate-400'}`;
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'wrench':
      return <svg viewBox="0 0 24 24" className={cls} {...common}><path d="M14.7 6.3a4 4 0 0 0 5 5L16 15l-3 3-3.3 3.3a2.1 2.1 0 0 1-3-3L10 15l3-3z" /></svg>;
    case 'oil':
      return <svg viewBox="0 0 24 24" className={cls} {...common}><path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9z" /></svg>;
    case 'battery':
      return <svg viewBox="0 0 24 24" className={cls} {...common}><rect x="2" y="8" width="16" height="9" rx="2" /><path d="M18 11h3v3h-3M7 6v2M13 6v2M8 12h4" /></svg>;
    case 'brake':
      return <svg viewBox="0 0 24 24" className={cls} {...common}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 4v3M12 17v3M4 12h3M17 12h3" /></svg>;
    case 'tire':
      return <svg viewBox="0 0 24 24" className={cls} {...common}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3v5M12 16v5M3 12h5M16 12h5" /></svg>;
    case 'clipboard':
      return <svg viewBox="0 0 24 24" className={cls} {...common}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9zM9 12h6M9 16h4" /></svg>;
    case 'sparkle':
      return <svg viewBox="0 0 24 24" className={cls} {...common}><path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 16l.9 2.3 2.3.9-2.3.9L18 22l-.9-1.9-2.3-.9 2.3-.9z" /></svg>;
    default:
      return <svg viewBox="0 0 24 24" className={cls} {...common}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3M12 17h.01" /></svg>;
  }
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
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={`text-right ${strong ? 'font-bold text-slate-900' : 'text-slate-800'}`}>
        {value}
        {sub && <span className="block font-mono text-xs text-slate-500">{sub}</span>}
      </span>
    </div>
  );
}
