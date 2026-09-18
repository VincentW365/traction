'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { SignaturePad } from '../../../../../components/signature-pad';
import { LoadingState } from '../../../../../components/ui/loading-state';

/**
 * CR-2026-093 — the Service Centre Job Card, digital.
 *
 * A faithful adaptation of the shop's own paper job card: same sections, same
 * order, same tick boxes — pre-filled from what the system already knows about the
 * visit, so nobody copies a chassis number by hand. Tick boxes and the directive
 * are editable on screen and print exactly as shown; blank lines print as blank
 * lines, because a printed sheet is still filled in with a pen.
 */

interface JobSheetData {
  id: string;
  visitNumber: string | null; // CR-2026-097
  mileageIn: number | null;
  createdAt: string;
  customer: {
    customerNumber: string | null;
    firstName: string;
    lastName: string;
    phone: string | null;
    email: string | null;
  } | null;
  vehicle: {
    plateNumber: string;
    make: string | null;
    model: string | null;
    modelYear: number | null;
    engineNo: string | null;
    vin: string | null;
    fuelType: string | null;
    transmission: string | null;
    drivetrain: string | null;
    // CR-2026-100 §10 — the authoritative vehicle type, from the vehicle record.
    serviceClass: 'SEDAN_CLASS' | 'SUV_CLASS' | 'UNKNOWN_REQUIRES_REVIEW' | null;
  } | null;
  queueTicket: { ticketNumber: string } | null;
  /** CR-2026-111 — what the customer asked for when they booked. */
  appointment: {
    sourceChannel: string | null;
    customerReportedMileage: number | null;
    services: Array<{ serviceType: { code: string; name: string; customerFacingName: string | null } }>;
    bookingIntake: {
      category: string;
      customerConcern: string | null;
      symptoms: string[];
      additionalComments: string | null;
    } | null;
  } | null;
  /** Fallback for bookings taken before the structured intake existed. */
  visitNotes: Array<{ text: string; createdAt: string; authorRole: string | null }>;
  jobSheetDraft: {
    data: {
      fields?: Record<string, string>;
      ticks?: Record<string, boolean>;
      pair?: Record<string, boolean>;
      directive?: string;
    };
    signatureImage: string | null;
    updatedAt: string;
  } | null;
  serviceOrders: Array<{
    id: string;
    notes: string | null;
    items: Array<{ serviceType: { code: string; name: string } }>;
    assignments: Array<{ technician: { userAccount: { fullName: string } } }>;
  }>;
}

/** The card's printed service tick list, matched against the order's real lines. */
const SERVICE_TICKS: Array<{ key: string; label: string; codes: string[] }> = [
  { key: 'oil', label: 'OIL & FILTER CHANGE', codes: ['OIL-01', 'OIL-FLT-01'] },
  { key: 'tuneup', label: 'ENGINE TUNE-UP', codes: ['ENG-02'] },
  { key: 'discFront', label: 'DISC PADS - FR', codes: [] },
  { key: 'discRear', label: 'RR', codes: [] },
  { key: 'shoe', label: 'BRAKE SHOE', codes: [] },
  { key: 'shocksGenuine', label: 'SHOCKS - GENUINE', codes: [] },
  { key: 'shocksKyb', label: 'KYB', codes: [] },
];

/**
 * A ruled fill-in line, and genuinely fillable: the underline is an input. It
 * prints exactly as typed, and an empty one prints as the blank line a pen expects.
 */
function Line({
  label, value, onChange, grow = 1,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  grow?: number;
}) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0" style={{ flexGrow: grow }}>
      <span className="text-[11px] font-extrabold text-slate-900 whitespace-nowrap">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-0 border-b border-slate-900 flex-grow min-w-0 px-1 text-[11px] text-slate-900 bg-transparent focus:outline-none focus:bg-amber-50"
      />
    </div>
  );
}

function SectionHeading({ children }: { children: string }) {
  return (
    <div className="bg-slate-900 text-white text-[11px] font-extrabold tracking-[0.07em] px-2.5 py-1 mt-4">
      {children}
    </div>
  );
}

function TickBox({ on, onToggle, label }: { on: boolean; onToggle: () => void; label?: string }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-1.5 print:pointer-events-none">
      {label && <span className="text-[11px] font-extrabold text-slate-900">{label}</span>}
      <span
        className="w-[15px] h-[15px] border-[1.5px] border-slate-900 bg-white inline-flex items-center justify-center text-[11px] font-black leading-none"
        style={{ color: on ? '#0f172a' : 'transparent' }}
      >
        ✓
      </span>
    </button>
  );
}

export default function JobSheetPage() {
  const { visitId } = useParams<{ visitId: string }>();
  const q = useQuery<JobSheetData>({
    queryKey: ['job-sheet', visitId],
    queryFn: () => api.get(`/service-visits/${visitId}/job-sheet`),
  });

  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [fields, setFields] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const setField = (key: string) => (v: string) => {
    setFields((prev) => ({ ...prev, [key]: v }));
    setDirty(true);
  };
  const [pair, setPair] = useState<Record<string, boolean>>({}); // ATM/MTM, 4WD/2WD, fuel
  const [directive, setDirective] = useState('');
  const [initialised, setInitialised] = useState(false);

  // Declared WITH the other hooks, above every early return. This mutation once sat
  // after the loading/error returns, so the first (loading) render mounted fewer
  // hooks than the data render — React's hooks-order invariant tripped the route's
  // error boundary on every cold load, and "Try Again" worked only because the
  // query was cached by then.
  const saveDraft = useMutation({
    mutationFn: () =>
      api.put<{ saved: boolean; updatedAt: string }>(`/service-visits/${visitId}/job-sheet-draft`, {
        data: { fields, ticks, pair, directive },
        signatureImage: signature,
      }),
    onSuccess: (r: { updatedAt: string }) => {
      setDirty(false);
      setSavedAt(r.updatedAt);
    },
  });

  const d = q.data;

  // A saved sheet is restored exactly as it was left; only a visit with no saved
  // sheet is pre-filled from what the system knows.
  if (d && !initialised) {
    setInitialised(true);
    if (d.jobSheetDraft?.data) {
      const saved = d.jobSheetDraft.data;
      setFields(saved.fields ?? {});
      setTicks(saved.ticks ?? {});
      setPair(saved.pair ?? {});
      setDirective(saved.directive ?? '');
      setSignature(d.jobSheetDraft.signatureImage);
      setSavedAt(d.jobSheetDraft.updatedAt);
      // eslint-disable-next-line no-constant-condition
    } else {
    const codes = new Set(d.serviceOrders.flatMap((o) => o.items.map((i) => i.serviceType.code)));
    const auto: Record<string, boolean> = {};
    for (const t of SERVICE_TICKS) if (t.codes.some((c) => codes.has(c))) auto[t.key] = true;
    setTicks(auto);
    const v = d.vehicle;
    const p: Record<string, boolean> = {};
    if (v?.transmission) p[v.transmission.toUpperCase().startsWith('A') ? 'ATM' : 'MTM'] = true;
    if (v?.drivetrain) p[v.drivetrain.toUpperCase().includes('4') ? '4WD' : '2WD'] = true;
    if (v?.fuelType) p[v.fuelType.toUpperCase().startsWith('D') ? 'DSL' : 'GAS'] = true;
    setPair(p);
    setDirective(d.serviceOrders.map((o) => o.notes).filter(Boolean).join('\n'));
    const cu = d.customer;
    setFields({
      date: new Date(d.createdAt).toLocaleDateString(),
      name: cu ? `${cu.firstName} ${cu.lastName}` : '',
      contact: cu?.phone ?? '',
      email: cu?.email ?? '',
      year: v?.modelYear ? String(v.modelYear) : '',
      make: v?.make ?? '',
      model: v?.model ?? '',
      licence: v?.plateNumber ?? '',
      engineNo: v?.engineNo ?? '',
      chassisNo: v?.vin ?? '',
      mileage: d.mileageIn != null ? d.mileageIn.toLocaleString() : '',
      nextMileage: '',
      nextDate: '',
      customerNo: cu?.customerNumber ?? '',
      preparedBy: '',
      mechanic: d.serviceOrders[0]?.assignments[0]?.technician?.userAccount?.fullName ?? '',
      salesInv: '',
      // The signature date pre-fills like the header date — today is when the
      // customer is standing at the desk signing.
      sigDate: new Date().toLocaleDateString(),
    });
    }
  }

  if (q.isLoading) return <div className="page-container"><LoadingState message="Loading job sheet..." /></div>;
  if (q.isError || !d) {
    return (
      <div className="page-container">
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Could not load this visit.</p>
        </div>
      </div>
    );
  }

  const c = d.customer;
  const v = d.vehicle;
  const intake = customerIntake(d);
  const togglePair = (group: string[], key: string) => {
    setDirty(true);
    return setPair((p) => {
      const next = { ...p };
      // One per group, and clicking the ticked one clears it.
      const was = next[key];
      for (const g of group) delete next[g];
      if (!was) next[key] = true;
      return next;
    });
  };

  return (
    <div className="page-container max-w-3xl">
      <div className="flex items-center justify-between mb-3 print:hidden">
        <div className="flex items-center gap-3">
          <Link href="/inspections" className="text-xs text-blue-600 hover:underline">← Inspections</Link>
          <Link href={`/visits/${visitId}`} className="text-xs text-blue-600 hover:underline" title="The complete record of this visit">Visit Record</Link>
          {q.data?.visitNumber && (
            <span className="text-[11px] font-mono text-slate-400" title="Job sheet number (derived from the visit number)">JS-{q.data.visitNumber}</span>
          )}
          {/* CR-2026-100 §10 — the vehicle type flows onto the job sheet automatically. */}
          {q.data?.vehicle?.serviceClass && q.data.vehicle.serviceClass !== 'UNKNOWN_REQUIRES_REVIEW' && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
              {q.data.vehicle.serviceClass === 'SEDAN_CLASS' ? 'Sedan' : 'SUV'}
            </span>
          )}
          {dirty ? (
            <span className="text-[11px] text-amber-600">Unsaved changes</span>
          ) : savedAt ? (
            <span className="text-[11px] text-slate-400">Saved {new Date(savedAt).toLocaleTimeString()}</span>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button onClick={() => saveDraft.mutate()} disabled={saveDraft.isPending} className="btn-secondary text-sm">
            {saveDraft.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => window.print()} className="btn-primary text-sm">Print</button>
        </div>
      </div>
      {saveDraft.isError && (
        <p className="text-xs text-red-600 mb-2 print:hidden">
          {saveDraft.error instanceof Error ? saveDraft.error.message : 'Could not save the sheet.'}
        </p>
      )}

      {/* The card */}
      <div className="bg-white border border-slate-400 shadow-sm px-7 py-6 print:border-0 print:shadow-none">
        {/* Letterhead */}
        <div className="flex items-start justify-between gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/berts-logo.png" alt="Bert's Auto Parts" className="h-14 w-auto" />
          <div className="text-[10px] text-slate-500 text-right leading-relaxed pt-1">
            Bert&apos;s Auto Parts Service Centre<br />Your Parts Specialist
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-5 mt-3">
          <h1 className="text-lg font-extrabold tracking-wide text-slate-900">SERVICE CENTRE JOB CARD</h1>
          <div className="min-w-[220px]">
            <Line label="DATE:" value={fields.date ?? ''} onChange={setField('date')} />
          </div>
        </div>
        {d.queueTicket && (
          <div className="text-[10px] text-slate-500 mt-0.5">Ticket {d.queueTicket.ticketNumber}</div>
        )}

        <SectionHeading>PERSONAL DATA</SectionHeading>
        <div className="flex flex-col gap-2.5 pt-3 px-0.5">
          <Line label="NAME:" value={fields.name ?? ''} onChange={setField('name')} />
          <div className="flex gap-3">
            <Line label="CONTACT NUMBER(S):" value={fields.contact ?? ''} onChange={setField('contact')} />
            <Line label="EMAIL ADDRESS:" value={fields.email ?? ''} onChange={setField('email')} grow={1.6} />
          </div>
        </div>

        <SectionHeading>VEHICLE DETAILS</SectionHeading>
        <div className="flex flex-col gap-2.5 pt-3 px-0.5">
          <div className="flex gap-3">
            <Line label="YEAR:" value={fields.year ?? ''} onChange={setField('year')} grow={0.5} />
            <Line label="MAKE:" value={fields.make ?? ''} onChange={setField('make')} />
            <Line label="MODEL:" value={fields.model ?? ''} onChange={setField('model')} grow={1.4} />
          </div>
          <div className="flex gap-3">
            <Line label="LICENCE:" value={fields.licence ?? ''} onChange={setField('licence')} />
            <Line label="ENGINE #:" value={fields.engineNo ?? ''} onChange={setField('engineNo')} />
            <Line label="CHASSIS #:" value={fields.chassisNo ?? ''} onChange={setField('chassisNo')} grow={1.3} />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Line label="MILEAGE:" value={fields.mileage ?? ''} onChange={setField('mileage')} grow={0.4} />
            <span className="text-[11px] font-extrabold text-slate-900">KM/ML</span>
            <span className="w-3" />
            <TickBox label="ATM" on={!!pair.ATM} onToggle={() => togglePair(['ATM', 'MTM'], 'ATM')} />
            <TickBox label="MTM" on={!!pair.MTM} onToggle={() => togglePair(['ATM', 'MTM'], 'MTM')} />
            <TickBox label="4WD" on={!!pair['4WD']} onToggle={() => togglePair(['4WD', '2WD'], '4WD')} />
            <TickBox label="2WD" on={!!pair['2WD']} onToggle={() => togglePair(['4WD', '2WD'], '2WD')} />
            <span className="text-[11px] font-extrabold text-slate-900 ml-2">Fuel:</span>
            <TickBox label="Dsl" on={!!pair.DSL} onToggle={() => togglePair(['DSL', 'GAS'], 'DSL')} />
            <TickBox label="Gas" on={!!pair.GAS} onToggle={() => togglePair(['DSL', 'GAS'], 'GAS')} />
          </div>
          <div className="flex items-baseline gap-3">
            <Line label="NEXT SERVICE MILEAGE:" value={fields.nextMileage ?? ''} onChange={setField('nextMileage')} grow={0.6} />
            <span className="text-[11px] font-extrabold text-slate-900">KM/ML</span>
            <Line label="DATE:" value={fields.nextDate ?? ''} onChange={setField('nextDate')} />
          </div>
        </div>

        <SectionHeading>SERVICE DETAILS</SectionHeading>
        <div className="flex flex-col gap-2.5 pt-3 px-0.5">
          <div className="flex items-center gap-6 flex-wrap">
            <TickBox label="OIL & FILTER CHANGE" on={!!ticks.oil} onToggle={() => setTicks((t) => ({ ...t, oil: !t.oil }))} />
            <TickBox label="ENGINE TUNE-UP" on={!!ticks.tuneup} onToggle={() => setTicks((t) => ({ ...t, tuneup: !t.tuneup }))} />
            <span className="flex items-center gap-2">
              <span className="text-[11px] font-extrabold text-slate-900">DISC PADS -</span>
              <TickBox label="FR" on={!!ticks.discFront} onToggle={() => setTicks((t) => ({ ...t, discFront: !t.discFront }))} />
              <TickBox label="RR" on={!!ticks.discRear} onToggle={() => setTicks((t) => ({ ...t, discRear: !t.discRear }))} />
            </span>
          </div>
          <div className="flex items-center gap-6 flex-wrap">
            <TickBox label="BRAKE SHOE" on={!!ticks.shoe} onToggle={() => setTicks((t) => ({ ...t, shoe: !t.shoe }))} />
            <span className="flex items-center gap-2">
              <span className="text-[11px] font-extrabold text-slate-900">SHOCKS -</span>
              <TickBox label="GENUINE" on={!!ticks.shocksGenuine} onToggle={() => setTicks((t) => ({ ...t, shocksGenuine: !t.shocksGenuine }))} />
              <TickBox label="KYB" on={!!ticks.shocksKyb} onToggle={() => setTicks((t) => ({ ...t, shocksKyb: !t.shocksKyb }))} />
            </span>
          </div>

          {/* Booked services beyond the card's printed list still appear */}
          {d.serviceOrders.some((o) => o.items.length > 0) && (
            <div className="text-[10px] text-slate-500">
              Booked: {d.serviceOrders.flatMap((o) => o.items.map((i) => i.serviceType.name)).join(', ')}
            </div>
          )}

          {/*
            CR-2026-111 §13 — three different things, kept apart.

            "Customer requested" is what they picked. "Customer concern" is what
            they wrote, verbatim. The directive below is what STAFF conclude. The
            first two are read-only here on purpose: an advisor editing the
            customer's own words would destroy the only record of what was
            actually reported, and "vibrates when braking above 80" is worth more
            to a technician than any tidied-up version of it.
          */}
          {intake && (
            <div className="mt-1 border border-slate-300 print:border-slate-400">
              <div className="bg-slate-100 px-2 py-1 text-[10px] font-extrabold tracking-wide text-slate-700">
                FROM THE CUSTOMER&apos;S BOOKING
              </div>
              <div className="px-2 py-1.5 space-y-1">
                {intake.requested && (
                  <p className="text-[11px] text-slate-900">
                    <span className="font-extrabold">REQUESTED: </span>
                    {intake.requested}
                  </p>
                )}
                {intake.concern && (
                  <p className="text-[11px] text-slate-900 leading-snug">
                    <span className="font-extrabold">CONCERN: </span>
                    <span className="italic">&ldquo;{intake.concern}&rdquo;</span>
                  </p>
                )}
                {intake.symptoms.length > 0 && (
                  <p className="text-[11px] text-slate-900">
                    <span className="font-extrabold">REPORTED: </span>
                    {intake.symptoms.join(', ')}
                  </p>
                )}
                {intake.comments && (
                  <p className="text-[11px] text-slate-900 leading-snug">
                    <span className="font-extrabold">ALSO: </span>
                    {intake.comments}
                  </p>
                )}
                <p className="text-[9px] text-slate-500 print:hidden">
                  The customer&apos;s own words, kept as submitted. Your conclusions go in the directive below.
                </p>
              </div>
            </div>
          )}

          <div className="mt-1">
            <div className="text-[11px] font-extrabold text-slate-900 mb-0.5">CUSTOMER&apos;S DIRECTIVE</div>
            <textarea
              value={directive}
              onChange={(e) => setDirective(e.target.value)}
              rows={4}
              className="w-full text-[11px] leading-[26px] text-slate-900 bg-transparent border-0 focus:outline-none resize-none print:resize-none"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(to bottom, transparent 0, transparent 25px, #94a3b8 25px, #94a3b8 26px)',
              }}
            />
          </div>
        </div>

        {/* Office use only */}
        <div className="border-2 border-slate-900 mt-5">
          <div className="bg-slate-900 text-white text-center text-[11px] font-extrabold tracking-[0.07em] py-1">
            OFFICE USE ONLY
          </div>
          <div className="flex flex-col gap-2.5 p-3.5">
            <Line label="CUSTOMER NO.:" value={fields.customerNo ?? ''} onChange={setField('customerNo')} />
            <Line label="PREPARED BY:" value={fields.preparedBy ?? ''} onChange={setField('preparedBy')} />
            <Line label="ASSIGNED MECHANIC:" value={fields.mechanic ?? ''} onChange={setField('mechanic')} />
            <Line label="SALES INV. #:" value={fields.salesInv ?? ''} onChange={setField('salesInv')} />
          </div>
        </div>

        {/* Signature — drawn in a pop-up, shown on the line, printed as ink */}
        <div className="flex items-end justify-center gap-3 mt-6">
          <span className="text-[11px] font-extrabold text-slate-900">CUSTOMER&apos;S SIGNATURE:</span>
          <button
            type="button"
            onClick={() => setSigning(true)}
            className="border-b border-slate-900 w-52 h-10 flex items-end justify-center print:pointer-events-none"
            title={signature ? 'Redraw signature' : 'Tap to sign'}
          >
            {signature ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={signature} alt="Customer signature" className="max-h-9 max-w-full object-contain" />
            ) : (
              <span className="text-[9px] text-slate-300 pb-0.5 print:hidden">tap to sign</span>
            )}
          </button>
          <div className="w-36">
            <Line label="DATE:" value={fields.sigDate ?? ''} onChange={setField('sigDate')} />
          </div>
        </div>
      </div>

      {signing && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center print:hidden">
          <div className="card w-full max-w-md mx-4">
            <div className="card-header flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Customer signature</h3>
              <button onClick={() => setSigning(false)} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
            </div>
            <div className="card-body space-y-3">
              <p className="text-[11px] text-slate-500">Sign in the box below — finger or stylus both work.</p>
              <SignaturePad
                onChange={(dataUrl) => {
                  setSignature(dataUrl);
                  setDirty(true);
                }}
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { setSignature(null); setDirty(true); }}
                  className="btn-secondary text-xs"
                >
                  Remove signature
                </button>
                <button onClick={() => setSigning(false)} className="btn-primary text-xs">Done</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-400 mt-3 print:hidden">
        Every line, tick and the directive are editable here and print exactly as shown — anything
        left empty prints as a blank line for pen, and the signature line always stays for pen.
        Filling in the sheet does not change the visit&apos;s booked services.
      </p>
    </div>
  );
}

/**
 * CR-2026-111 — what the customer said, assembled for the sheet.
 *
 * Prefers the structured intake and falls back to the CUSTOMER_CONCERN note, so a
 * booking taken before this CR still shows its concern rather than a blank panel.
 * Returns null when there is genuinely nothing — an empty bordered box on a
 * printed card is worse than no box.
 */
function customerIntake(d: JobSheetData): {
  requested: string | null;
  concern: string | null;
  symptoms: string[];
  comments: string | null;
} | null {
  const a = d.appointment;
  const requested =
    a?.services.map((s) => s.serviceType.customerFacingName?.trim() || s.serviceType.name).join(', ') || null;

  if (a?.bookingIntake) {
    const i = a.bookingIntake;
    return {
      requested,
      concern: i.customerConcern,
      symptoms: i.symptoms.map(readableSymptom),
      comments: i.additionalComments,
    };
  }

  // Older bookings: the concern survives only as a visit note.
  const note = d.visitNotes.find((n) => n.authorRole === 'CUSTOMER_BOOKING')?.text ?? null;
  if (!note && !requested) return null;
  return {
    requested,
    concern: note ? note.replace(/^From the online booking:s*/, '') : null,
    symptoms: [],
    comments: null,
  };
}

/** A ticked symptom code in words. Mirrors the API's vocabulary. */
function readableSymptom(code: string): string {
  const known: Record<string, string> = {
    BATTERY_SLOW_START: 'difficult or slow starting',
    BATTERY_REPEATEDLY_FLAT: 'battery keeps going flat',
    BATTERY_WARNING_LIGHT: 'battery warning light',
    BATTERY_REPLACEMENT_REQUESTED: 'asked for a replacement battery',
    BRAKE_NOISE: 'brake noise',
    BRAKE_VIBRATION: 'brake vibration',
    BRAKE_WARNING_LIGHT: 'brake warning light',
    BRAKE_REDUCED_PERFORMANCE: 'reduced braking performance',
    BRAKE_PAD_REPLACEMENT_REQUESTED: 'asked for brake pad replacement',
    ALIGN_PULLS_LEFT: 'pulls to the left',
    ALIGN_PULLS_RIGHT: 'pulls to the right',
    ALIGN_UNEVEN_TYRE_WEAR: 'uneven tyre wear',
    ALIGN_WHEEL_OFF_CENTRE: 'steering wheel off-centre',
    ALIGN_VIBRATION: 'vibration',
    COOLING_OVERHEATING: 'overheating',
    COOLING_COOLANT_CONCERN: 'coolant concern',
    COOLING_LEAK: 'suspected leak',
    NOT_SURE: 'not sure',
  };
  return known[code] ?? code.toLowerCase().replace(/_/g, ' ');
}
