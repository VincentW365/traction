'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, getToken } from '../../../../lib/api-client';
import { LoadingState } from '../../../../components/ui/loading-state';

/**
 * CR-2026-093 — the inspection record itself.
 *
 * Two kinds share this route. A VEHICLE_INSPECTION renders as a digital adaptation
 * of the shop's paper Visual Vehicle Inspection Report — same section order, same
 * green/amber/red language, same four-wheel grid, document-styled — backed by the
 * item rows the API snapshotted from the template. A PRE_INSPECTION renders as the
 * photo-first condition record.
 *
 * The honest-form rules carry through from the API: nothing starts ticked, a
 * selected result shows its LETTER (O/F/I/N) so a black-and-white print still
 * reads, clicking a selected box clears it back to Not Inspected, and completing
 * with untouched items warns with the exact count instead of silently passing them.
 */

// ---------------------------------------------------------------------------
// Types (the API detail shape)
// ---------------------------------------------------------------------------

interface Item {
  id: string;
  category: string;
  label: string;
  orderIndex: number;
  result: string;
  note: string | null;
}
interface Wheel {
  position: string;
  brakeLiningMm: number | null;
  tireTread32nds: number | null;
  wearPattern: string | null;
  tirePressureBeforePsi: number | null;
  tirePressureAfterPsi: number | null;
  rotorOrDrum: string | null;
}
interface Recommendation {
  id: string;
  severity: string;
  description: string;
  customerDecision: string;
  suggestedServiceTypeCode: string | null;
}
interface Photo {
  id: string;
  category: string;
  caption: string | null;
  isPrimary: boolean;
}
interface Inspection {
  id: string;
  inspectionNumber: string;
  kind: 'VEHICLE_INSPECTION' | 'PRE_INSPECTION';
  status: string;
  batteryTestResult: string | null;
  batteryFactoryCca: number | null;
  batteryActualCca: number | null;
  alignmentCheckNeeded: boolean;
  wheelBalanceNeeded: boolean;
  brakeInspectionPerformed: boolean;
  priorBodyDamageNotes: string | null;
  comments: string | null;
  generalCondition: string | null;
  visibleDamage: boolean | null;
  damageNotes: string | null;
  itemsLeftInside: string | null;
  warningLights: string | null;
  fuelLevelNote: string | null;
  odometerReading: number | null;
  createdAt: string;
  customer: { firstName: string; lastName: string; phone: string | null } | null;
  vehicle: { plateNumber: string; make: string | null; model: string | null; modelYear: number | null } | null;
  serviceVisit: { id: string; status: string } | null;
  items: Item[];
  wheelMeasurements: Wheel[];
  recommendations: Recommendation[];
  signatures: Array<{ id: string; role: string; typedName: string | null; signedAt: string }>;
  photos: Photo[];
}

// ---------------------------------------------------------------------------
// Result vocabulary — the paper form's own letters, never colour alone
// ---------------------------------------------------------------------------

const RESULTS = [
  { value: 'OK', letter: 'O', label: 'Checked and Okay', bg: '#00a651', fg: '#ffffff' },
  { value: 'FUTURE', letter: 'F', label: 'May Need Future Attention', bg: '#ffd400', fg: '#0f172a' },
  { value: 'IMMEDIATE', letter: 'I', label: 'Requires Immediate Attention', bg: '#e02020', fg: '#ffffff' },
  { value: 'NOT_APPLICABLE', letter: 'N', label: 'Not Applicable', bg: '#64748b', fg: '#ffffff' },
] as const;

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  COMPLETED: 'Completed',
  SIGNED_OFF: 'Signed off',
  CLOSED: 'Closed',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
};

const WHEEL_LABEL: Record<string, string> = {
  LEFT_FRONT: 'Left Front',
  RIGHT_FRONT: 'Right Front',
  LEFT_REAR: 'Left Rear',
  RIGHT_REAR: 'Right Rear',
};

const PHOTO_CATEGORIES = [
  'FRONT', 'REAR', 'DRIVER_SIDE', 'PASSENGER_SIDE', 'INTERIOR',
  'DASHBOARD_ODOMETER', 'EXISTING_DAMAGE', 'WHEEL_TIRE', 'OTHER',
] as const;
const PHOTO_CATEGORY_LABEL: Record<string, string> = {
  FRONT: 'Front', REAR: 'Rear', DRIVER_SIDE: 'Driver Side', PASSENGER_SIDE: 'Passenger Side',
  INTERIOR: 'Interior', DASHBOARD_ODOMETER: 'Dashboard / Odometer', EXISTING_DAMAGE: 'Existing Damage',
  WHEEL_TIRE: 'Wheel / Tire', OTHER: 'Other',
};

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Photographs are behind an authenticated endpoint; an <img src> cannot carry the token. */
function usePhotoUrl(inspectionId: string, photoId: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    const base = process.env.NEXT_PUBLIC_API_URL ?? `${window.location.protocol}//${window.location.hostname}:3001/api/v1`;
    fetch(`${base}/inspections/${inspectionId}/photos/${photoId}/file`, {
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && alive) {
          objectUrl = URL.createObjectURL(b);
          setUrl(objectUrl);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [inspectionId, photoId]);
  return url;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InspectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery<Inspection>({
    queryKey: ['inspection', id],
    queryFn: () => api.get(`/inspections/${id}`),
  });

  if (q.isLoading) return <div className="page-container"><LoadingState message="Loading inspection..." /></div>;
  if (q.isError || !q.data) {
    return (
      <div className="page-container">
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Could not load this inspection.</p>
        </div>
      </div>
    );
  }
  return q.data.kind === 'PRE_INSPECTION'
    ? <PreInspectionView inspection={q.data} />
    : <VehicleInspectionForm inspection={q.data} />;
}

// ---------------------------------------------------------------------------
// The Vehicle Inspection — document-styled, from the paper form
// ---------------------------------------------------------------------------

function VehicleInspectionForm({ inspection }: { inspection: Inspection }) {
  const qc = useQueryClient();
  const router = useRouter();
  const editable = inspection.status === 'DRAFT';

  // Local editing state, initialised once from the record.
  const [results, setResults] = useState<Record<string, string>>(() =>
    Object.fromEntries(inspection.items.map((i) => [i.id, i.result])),
  );
  const [wheels, setWheels] = useState<Record<string, Partial<Wheel>>>(() =>
    Object.fromEntries(inspection.wheelMeasurements.map((w) => [w.position, { ...w }])),
  );
  const [battery, setBattery] = useState({
    batteryTestResult: inspection.batteryTestResult,
    batteryFactoryCca: inspection.batteryFactoryCca,
    batteryActualCca: inspection.batteryActualCca,
  });
  const [flags, setFlags] = useState({
    alignmentCheckNeeded: inspection.alignmentCheckNeeded,
    wheelBalanceNeeded: inspection.wheelBalanceNeeded,
    brakeInspectionPerformed: inspection.brakeInspectionPerformed,
  });
  const [damageNotes, setDamageNotes] = useState(inspection.priorBodyDamageNotes ?? '');
  const [comments, setComments] = useState(inspection.comments ?? '');
  const [dirty, setDirty] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['inspection', inspection.id] });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/inspections/${inspection.id}`, {
        ...battery,
        batteryTestResult: battery.batteryTestResult || undefined,
        ...flags,
        priorBodyDamageNotes: damageNotes,
        comments,
        items: inspection.items.map((i) => ({ itemId: i.id, result: results[i.id] })),
        wheels: Object.entries(wheels).map(([position, w]) => ({
          position,
          brakeLiningMm: w.brakeLiningMm ?? undefined,
          tireTread32nds: w.tireTread32nds ?? undefined,
          wearPattern: w.wearPattern ?? undefined,
          tirePressureBeforePsi: w.tirePressureBeforePsi ?? undefined,
          tirePressureAfterPsi: w.tirePressureAfterPsi ?? undefined,
          rotorOrDrum: w.rotorOrDrum ?? undefined,
        })),
      }),
    onSuccess: () => {
      setDirty(false);
      invalidate();
    },
  });

  const complete = useMutation({
    mutationFn: () => api.post(`/inspections/${inspection.id}/complete`, {}),
    onSuccess: invalidate,
  });
  const skip = useMutation({
    mutationFn: (reason: string) => api.post(`/inspections/${inspection.id}/skip`, { reason }),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/inspections/${inspection.id}/cancel`, {}),
    onSuccess: () => router.push('/inspections'),
  });
  const signoff = useMutation({
    mutationFn: (typedName: string) =>
      api.post(`/inspections/${inspection.id}/signoff`, { type: 'TYPED', typedName }),
    onSuccess: invalidate,
  });
  const customerAck = useMutation({
    mutationFn: (typedName: string) =>
      api.post(`/inspections/${inspection.id}/customer-signoff`, { type: 'TYPED', typedName }),
    onSuccess: invalidate,
  });

  const notInspectedCount = useMemo(
    () => Object.values(results).filter((r) => r === 'NOT_INSPECTED').length,
    [results],
  );

  const onComplete = async () => {
    if (dirty) await save.mutateAsync();
    if (notInspectedCount > 0) {
      const ok = confirm(
        `${notInspectedCount} item${notInspectedCount === 1 ? ' has' : 's have'} not been inspected. ` +
          'You may still complete this optional inspection, but these items will be shown as Not Inspected.',
      );
      if (!ok) return;
    }
    complete.mutate();
  };

  const setResult = (itemId: string, value: string) => {
    if (!editable) return;
    setResults((r) => ({
      ...r,
      // Clicking the selected result clears it — a mis-tap must not leave a finding
      // nobody meant to record.
      [itemId]: r[itemId] === value ? 'NOT_INSPECTED' : value,
    }));
    setDirty(true);
  };

  // Sections in the paper form's order: Battery moves to the right column; the
  // rest keep the template's own sequence on the left.
  const grouped = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of inspection.items) {
      if (!map.has(it.category)) map.set(it.category, []);
      map.get(it.category)!.push(it);
    }
    return map;
  }, [inspection.items]);
  const leftSections = [...grouped.entries()].filter(([c]) => c !== 'Battery');
  const batteryItems = grouped.get('Battery') ?? [];

  const v = inspection.vehicle;
  const c = inspection.customer;

  return (
    <div className="page-container max-w-5xl">
      {/* Toolbar — deliberately outside the document */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Link href="/inspections" className="text-xs text-blue-600 hover:underline">← Inspections</Link>
          <span className="badge bg-indigo-50 text-indigo-700 text-[11px]">Vehicle Inspection</span>
          <span className="badge bg-slate-100 text-slate-600 text-[11px]">{STATUS_LABEL[inspection.status] ?? inspection.status}</span>
          {dirty && <span className="text-[11px] text-amber-600">Unsaved changes</span>}
        </div>
        <div className="flex gap-2">
          <Link href={`/inspections/${inspection.id}/print`} className="btn-secondary text-xs">Print</Link>
          {editable && (
            <>
              <button
                onClick={() => {
                  const reason = prompt('Mark this inspection as deliberately skipped. Reason:');
                  if (reason?.trim()) skip.mutate(reason.trim());
                }}
                className="btn-secondary text-xs"
              >
                Skip
              </button>
              <button
                onClick={() => confirm('Cancel this inspection record? Use this only for records created in error.') && cancel.mutate()}
                className="btn-secondary text-xs text-red-600"
              >
                Cancel Record
              </button>
            </>
          )}
        </div>
      </div>

      {/* The document */}
      <div className="bg-white border border-slate-400 shadow-sm">
        {/* Letterhead */}
        <div className="flex items-center justify-between gap-4 px-5 pt-4 pb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/berts-logo.png" alt="Bert's Auto Parts" className="h-11 w-auto" />
          <div className="text-[10px] text-slate-500 text-right leading-relaxed">
            {inspection.inspectionNumber}<br />Bert&apos;s Auto Parts Service Centre
          </div>
        </div>
        <div className="text-center px-5 pb-3">
          <h1 className="text-xl font-extrabold tracking-wide text-slate-900">VISUAL VEHICLE INSPECTION REPORT</h1>
          <div className="h-[3px] bg-slate-900 mt-1.5" />
        </div>

        {/* Header fields — auto-filled, never retyped */}
        <div className="px-5 pb-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1.5 text-[11px]">
          <HeaderField label="Customer" value={c ? `${c.firstName} ${c.lastName}` : '—'} />
          <HeaderField label="Yr./Make/Model" value={v ? `${v.modelYear ?? ''} ${v.make ?? ''} ${v.model ?? ''}`.trim() || '—' : '—'} />
          <HeaderField label="Plate / Tag #" value={v?.plateNumber ?? '—'} />
          <HeaderField label="Date" value={new Date(inspection.createdAt).toLocaleDateString()} />
        </div>

        {/* Two-column body */}
        <div className="grid grid-cols-1 lg:grid-cols-2 border-t-2 border-slate-900">
          {/* LEFT */}
          <div className="lg:border-r-2 lg:border-slate-900">
            <Legend />
            {leftSections.map(([category, items]) => (
              <div key={category}>
                <SectionBar title={category} />
                {items.map((it) => (
                  <ItemRow key={it.id} item={it} value={results[it.id]} editable={editable} onPick={setResult} />
                ))}
              </div>
            ))}
          </div>

          {/* RIGHT */}
          <div className="border-t-2 border-slate-900 lg:border-t-0">
            <div className="hidden lg:block"><Legend /></div>
            <SectionBar title="Battery" />
            {batteryItems.map((it) => (
              <ItemRow key={it.id} item={it} value={results[it.id]} editable={editable} onPick={setResult} />
            ))}

            {/* Battery test + CCA */}
            <div className="flex items-center gap-4 px-3 py-2 border-b border-slate-300 flex-wrap">
              {(
                [
                  ['PASS', 'Pass', '#00a651', '#ffffff'],
                  ['RECHARGE_RETEST', 'Recharge & Retest', '#ffd400', '#0f172a'],
                  ['FAIL', 'Fail', '#e02020', '#ffffff'],
                ] as const
              ).map(([value, label, bg, fg]) => {
                const on = battery.batteryTestResult === value;
                return (
                  <button
                    key={value}
                    disabled={!editable}
                    onClick={() => {
                      setBattery((b) => ({ ...b, batteryTestResult: on ? null : value }));
                      setDirty(true);
                    }}
                    className="flex items-center gap-1.5"
                  >
                    <span
                      className="w-4 h-4 border-2 flex items-center justify-center text-[10px] font-black leading-none"
                      style={{ borderColor: bg, background: on ? bg : '#fff', color: on ? fg : 'transparent' }}
                    >
                      ✓
                    </span>
                    <span className="text-[10.5px] font-bold text-slate-900">{label}</span>
                  </button>
                );
              })}
              <div className="ml-auto flex flex-col gap-1">
                <CcaInput label="Factory Spec CCA" value={battery.batteryFactoryCca} editable={editable}
                  onChange={(n) => { setBattery((b) => ({ ...b, batteryFactoryCca: n })); setDirty(true); }} />
                <CcaInput label="Actual CCA" value={battery.batteryActualCca} editable={editable}
                  onChange={(n) => { setBattery((b) => ({ ...b, batteryActualCca: n })); setDirty(true); }} />
              </div>
            </div>

            {/* Brake and tire */}
            <SectionBar title="Brake and Tire" />
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/tire-decor.png" alt="" aria-hidden className="hidden" />
              <div className="grid grid-cols-1 sm:grid-cols-2">
                {(['LEFT_FRONT', 'RIGHT_FRONT', 'LEFT_REAR', 'RIGHT_REAR'] as const).map((pos, idx) => (
                  <WheelCard
                    key={pos}
                    position={pos}
                    wheel={wheels[pos] ?? {}}
                    editable={editable}
                    bordered={idx % 2 === 0}
                    onChange={(patch) => {
                      setWheels((w) => ({ ...w, [pos]: { ...w[pos], ...patch } }));
                      setDirty(true);
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="flex flex-wrap justify-between gap-2 px-3 py-2 border-y border-slate-300 text-[10.5px] font-bold text-slate-900">
              <Tick label="Alignment Check Needed" on={flags.alignmentCheckNeeded} editable={editable}
                onToggle={() => { setFlags((f) => ({ ...f, alignmentCheckNeeded: !f.alignmentCheckNeeded })); setDirty(true); }} />
              <Tick label="Wheel Balance Needed" on={flags.wheelBalanceNeeded} editable={editable}
                onToggle={() => { setFlags((f) => ({ ...f, wheelBalanceNeeded: !f.wheelBalanceNeeded })); setDirty(true); }} />
              <Tick label="Brake Inspection Not Performed This Visit" on={!flags.brakeInspectionPerformed} editable={editable}
                onToggle={() => { setFlags((f) => ({ ...f, brakeInspectionPerformed: !f.brakeInspectionPerformed })); setDirty(true); }} />
            </div>

            {/* Prior body damage */}
            <SectionBar title="Prior Body Damage" />
            <div className="p-3 bg-slate-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/body-damage.png" alt="Vehicle outline — note prior damage below" className="w-full h-auto" />
              <textarea
                value={damageNotes}
                onChange={(e) => { setDamageNotes(e.target.value); setDirty(true); }}
                disabled={!editable}
                placeholder="No prior damage observed / describe prior damage…"
                rows={2}
                className="input-field mt-2 text-xs"
              />
            </div>

            {/* Comments */}
            <SectionBar title="Comments / Estimates" />
            <div className="p-3">
              <textarea
                value={comments}
                onChange={(e) => { setComments(e.target.value); setDirty(true); }}
                disabled={!editable}
                rows={4}
                placeholder="General comments and estimate notes…"
                className="input-field text-xs"
              />
            </div>
          </div>
        </div>

        {/* Result key — letters, never colour alone */}
        <div className="border-t-2 border-slate-900 px-5 py-2.5 flex flex-wrap gap-4 items-center bg-slate-50">
          <span className="text-[10px] font-extrabold tracking-wider text-slate-900">RESULT KEY</span>
          {RESULTS.map((r) => (
            <span key={r.value} className="flex items-center gap-1.5 text-[10px] text-slate-600">
              <span className="w-4 h-4 border-2 flex items-center justify-center text-[9px] font-black"
                style={{ borderColor: r.bg, background: r.bg, color: r.fg }}>{r.letter}</span>
              {r.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-[10px] text-slate-600">
            <span className="w-4 h-4 border-2 border-slate-400 bg-white flex items-center justify-center text-[9px] font-black text-slate-500">—</span>
            Not Inspected
          </span>
        </div>
      </div>

      {/* Photographs */}
      <PhotoSection inspection={inspection} editable={editable || inspection.status === 'COMPLETED'} onChanged={invalidate} />

      {/* Findings and recommendations */}
      <RecommendationSection inspection={inspection} editable={editable} onChanged={invalidate} />

      {/* Sign-off — optional, never blocking */}
      <SignatureSection inspection={inspection} onSignoff={(n) => signoff.mutate(n)} onAck={(n) => customerAck.mutate(n)} />

      {(save.isError || complete.isError || skip.isError) && (
        <p className="text-xs text-red-600 mt-3">
          {errText(save.error ?? complete.error ?? skip.error, 'Something could not be saved.')}
        </p>
      )}

      {/* Sticky actions */}
      {editable && (
        <div className="sticky bottom-0 mt-4 -mx-4 px-4 py-3 bg-white border-t border-slate-200 shadow-[0_-1px_3px_rgba(15,23,42,0.08)] flex gap-2 justify-end">
          <span className="mr-auto self-center text-[11px] text-slate-500">
            {notInspectedCount > 0 ? `${notInspectedCount} item(s) not inspected` : 'All items answered'}
          </span>
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-secondary text-sm">
            {save.isPending ? 'Saving…' : 'Save Draft'}
          </button>
          <button onClick={onComplete} disabled={complete.isPending} className="btn-primary text-sm">
            Complete Inspection
          </button>
        </div>
      )}
    </div>
  );
}

function HeaderField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0">
      <span className="font-bold text-slate-900 whitespace-nowrap">{label}:</span>
      <span className="border-b border-slate-900 flex-grow px-1 truncate">{value}</span>
    </div>
  );
}

function Legend() {
  return (
    <div>
      <div className="text-[10.5px] font-extrabold text-white px-2 py-0.5" style={{ background: '#00a651' }}>CHECKED AND OKAY</div>
      <div className="text-[10.5px] font-extrabold text-slate-900 px-2 py-0.5 pl-7" style={{ background: '#ffd400' }}>MAY NEED FUTURE ATTENTION</div>
      <div className="text-[10.5px] font-extrabold text-white px-2 py-0.5 pl-12" style={{ background: '#e02020' }}>REQUIRES IMMEDIATE ATTENTION</div>
    </div>
  );
}

function SectionBar({ title }: { title: string }) {
  return (
    <div className="bg-slate-900 text-white text-center text-[11px] font-extrabold tracking-widest uppercase py-1">
      {title}
    </div>
  );
}

function ItemRow({
  item, value, editable, onPick,
}: {
  item: Item;
  value: string;
  editable: boolean;
  onPick: (id: string, value: string) => void;
}) {
  return (
    <div className="flex items-stretch border-b border-slate-300">
      <div className="flex gap-1 items-center px-2 py-1.5 border-r border-slate-300">
        {RESULTS.map((r) => {
          const on = value === r.value;
          return (
            <button
              key={r.value}
              type="button"
              disabled={!editable}
              title={r.label}
              onClick={() => onPick(item.id, r.value)}
              className="w-[26px] h-[26px] md:w-4 md:h-4 border-2 flex items-center justify-center text-[10px] font-black leading-none"
              style={{
                borderColor: r.bg,
                background: on ? r.bg : '#ffffff',
                color: on ? r.fg : 'transparent',
                cursor: editable ? 'pointer' : 'default',
              }}
            >
              {r.letter}
            </button>
          );
        })}
      </div>
      <div className="flex-grow px-2 py-1.5 text-[10.5px] leading-snug text-slate-900 self-center">{item.label}</div>
    </div>
  );
}

function CcaInput({
  label, value, editable, onChange,
}: {
  label: string;
  value: number | null;
  editable: boolean;
  onChange: (n: number | null) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 justify-end">
      <span className="text-[8.5px] font-bold text-slate-900 text-right leading-tight w-24">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        disabled={!editable}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="w-16 h-5 border border-slate-900 text-[10px] text-center"
      />
    </label>
  );
}

function WheelCard({
  position, wheel, editable, bordered, onChange,
}: {
  position: string;
  wheel: Partial<Wheel>;
  editable: boolean;
  bordered: boolean;
  onChange: (patch: Partial<Wheel>) => void;
}) {
  const num = (v: string) => (v === '' ? null : Number(v));
  const line = 'flex-grow border-0 border-b border-slate-400 text-[10px] text-center h-4 bg-transparent focus:outline-none focus:border-slate-900';
  return (
    <div className={`px-2.5 py-2 border-b border-slate-300 ${bordered ? 'sm:border-r' : ''}`}>
      <div className="text-[9.5px] font-extrabold text-slate-900 mb-1">{WHEEL_LABEL[position]}</div>
      <div className="flex flex-col gap-1 text-[9px] text-slate-900">
        <label className="flex items-baseline gap-1">Brake Lining
          <input type="number" step="0.5" disabled={!editable} value={wheel.brakeLiningMm ?? ''} onChange={(e) => onChange({ brakeLiningMm: num(e.target.value) })} className={line} />mm
        </label>
        <label className="flex items-baseline gap-1">Tire Tread
          <input type="number" disabled={!editable} value={wheel.tireTread32nds ?? ''} onChange={(e) => onChange({ tireTread32nds: num(e.target.value) })} className={line} />32nds
        </label>
        <label className="flex items-baseline gap-1">Wear Pattern
          <input disabled={!editable} value={wheel.wearPattern ?? ''} onChange={(e) => onChange({ wearPattern: e.target.value })} className={line} />
        </label>
        <div className="text-center text-[8.5px]">Tire Pressure PSI</div>
        <div className="flex items-baseline gap-1 text-[8.5px]">
          Before<input type="number" disabled={!editable} value={wheel.tirePressureBeforePsi ?? ''} onChange={(e) => onChange({ tirePressureBeforePsi: num(e.target.value) })} className={line} />
          After<input type="number" disabled={!editable} value={wheel.tirePressureAfterPsi ?? ''} onChange={(e) => onChange({ tirePressureAfterPsi: num(e.target.value) })} className={line} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {(['ROTOR', 'DRUM'] as const).map((rd) => (
            <button key={rd} type="button" disabled={!editable}
              onClick={() => onChange({ rotorOrDrum: wheel.rotorOrDrum === rd ? null : rd })}
              className="flex items-center gap-1">
              <span className="w-3.5 h-3.5 border-2 border-slate-900 flex items-center justify-center text-[9px] font-black"
                style={{ background: '#fff', color: wheel.rotorOrDrum === rd ? '#0f172a' : 'transparent' }}>✓</span>
              <span className="text-[9px] font-bold">{rd === 'ROTOR' ? 'Rotor' : 'Drum'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Tick({ label, on, editable, onToggle }: { label: string; on: boolean; editable: boolean; onToggle: () => void }) {
  return (
    <button type="button" disabled={!editable} onClick={onToggle} className="flex items-center gap-1.5">
      <span className="w-4 h-4 border-2 border-slate-900 bg-white flex items-center justify-center text-[10px] font-black"
        style={{ color: on ? '#0f172a' : 'transparent' }}>✓</span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Photographs (shared by both kinds)
// ---------------------------------------------------------------------------

function PhotoThumb({ inspectionId, photo, editable, onDelete }: {
  inspectionId: string;
  photo: Photo;
  editable: boolean;
  onDelete: (id: string) => void;
}) {
  const url = usePhotoUrl(inspectionId, photo.id);
  const [full, setFull] = useState(false);
  return (
    <>
      <div className="relative group">
        <button type="button" onClick={() => url && setFull(true)} className="block w-full">
          <div className="aspect-[4/3] rounded-md border border-slate-200 bg-slate-100 overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {url ? <img src={url} alt={photo.caption ?? PHOTO_CATEGORY_LABEL[photo.category]} className="w-full h-full object-cover" /> : null}
          </div>
        </button>
        <div className="mt-0.5 flex items-center justify-between gap-1">
          <span className="text-[10px] text-slate-500 truncate">
            {photo.isPrimary ? '★ ' : ''}{PHOTO_CATEGORY_LABEL[photo.category] ?? photo.category}
          </span>
          {editable && (
            <button onClick={() => onDelete(photo.id)} className="text-[10px] text-red-500 opacity-0 group-hover:opacity-100">
              remove
            </button>
          )}
        </div>
      </div>
      {full && url && (
        <div className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-6" onClick={() => setFull(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="max-h-full max-w-full rounded" />
        </div>
      )}
    </>
  );
}

function PhotoSection({ inspection, editable, onChanged }: {
  inspection: Inspection;
  editable: boolean;
  onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<string>('OTHER');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL ?? `${window.location.protocol}//${window.location.hostname}:3001/api/v1`;
      const form = new FormData();
      form.append('file', file);
      form.append('category', category);
      const res = await fetch(`${base}/inspections/${inspection.id}/photos/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? 'Upload failed');
      }
      onChanged();
    } catch (e) {
      setUploadError(errText(e, 'Upload failed'));
    } finally {
      setUploading(false);
    }
  };

  const del = useMutation({
    mutationFn: (photoId: string) => api.delete(`/inspections/${inspection.id}/photos/${photoId}`),
    onSuccess: onChanged,
    onError: (e: unknown) => setUploadError(errText(e, 'Could not remove the photo')),
  });

  return (
    <div className="card mt-4">
      <div className="card-header flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Photographs ({inspection.photos.length})</h2>
        {editable && (
          <div className="flex items-center gap-2">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-field w-auto text-xs py-1">
              {PHOTO_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{PHOTO_CATEGORY_LABEL[cat]}</option>
              ))}
            </select>
            <button onClick={() => cameraRef.current?.click()} disabled={uploading} className="btn-primary text-xs">
              {uploading ? 'Uploading…' : 'Take Photo'}
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={uploading} className="btn-secondary text-xs">
              Upload Image
            </button>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </div>
        )}
      </div>
      <div className="card-body">
        {uploadError && <p className="text-xs text-red-600 mb-2">{uploadError}</p>}
        {inspection.photos.length === 0 ? (
          <p className="text-xs text-slate-500">No photographs attached{editable ? ' — use Take Photo on a tablet or phone.' : '.'}</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
            {inspection.photos.map((p) => (
              <PhotoThumb key={p.id} inspectionId={inspection.id} photo={p}
                editable={inspection.status === 'DRAFT'} onDelete={(id) => del.mutate(id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function RecommendationSection({ inspection, editable, onChanged }: {
  inspection: Inspection;
  editable: boolean;
  onChanged: () => void;
}) {
  const [desc, setDesc] = useState('');
  const [severity, setSeverity] = useState('FUTURE');

  const add = useMutation({
    mutationFn: () => api.post(`/inspections/${inspection.id}/recommendations`, { severity, description: desc.trim() }),
    onSuccess: () => { setDesc(''); onChanged(); },
  });
  const decide = useMutation({
    mutationFn: (v: { rid: string; decision: string }) =>
      api.patch(`/inspections/${inspection.id}/recommendations/${v.rid}/decision`, { decision: v.decision }),
    onSuccess: onChanged,
  });

  return (
    <div className="card mt-4">
      <div className="card-header">
        <h2 className="text-sm font-semibold text-slate-900">Findings &amp; Recommendations ({inspection.recommendations.length})</h2>
      </div>
      <div className="card-body space-y-2">
        {inspection.recommendations.map((r) => (
          <div key={r.id} className="flex items-center gap-3 border-b border-slate-100 pb-2 last:border-0 text-xs">
            <span className={`badge text-[10px] ${r.severity === 'IMMEDIATE' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
              {r.severity === 'IMMEDIATE' ? 'Immediate' : 'Future'}
            </span>
            <span className="flex-grow text-slate-800">{r.description}</span>
            <span className="badge bg-slate-100 text-slate-600 text-[10px]">{r.customerDecision.toLowerCase()}</span>
            {r.customerDecision === 'PENDING' && (
              <div className="flex gap-1">
                {['APPROVED', 'DECLINED', 'DEFERRED'].map((d) => (
                  <button key={d} onClick={() => decide.mutate({ rid: r.id, decision: d })}
                    className="btn-secondary text-[10px] py-0.5 px-1.5">
                    {d.charAt(0) + d.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {inspection.recommendations.length === 0 && (
          <p className="text-xs text-slate-500">No findings recorded.</p>
        )}
        {editable && (
          <div className="flex gap-2 pt-1">
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="input-field w-auto text-xs">
              <option value="FUTURE">Future attention</option>
              <option value="IMMEDIATE">Immediate</option>
            </select>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Describe the finding…" className="input-field text-xs flex-grow" />
            <button onClick={() => desc.trim() && add.mutate()} disabled={add.isPending} className="btn-secondary text-xs">Add</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signatures — optional by design
// ---------------------------------------------------------------------------

function SignatureSection({ inspection, onSignoff, onAck }: {
  inspection: Inspection;
  onSignoff: (name: string) => void;
  onAck: (name: string) => void;
}) {
  const senior = inspection.signatures.find((s) => s.role === 'SENIOR_TECH');
  const cust = inspection.signatures.find((s) => s.role === 'CUSTOMER');
  const canSign = inspection.status === 'COMPLETED' || inspection.status === 'SIGNED_OFF';

  return (
    <div className="card mt-4">
      <div className="card-header">
        <h2 className="text-sm font-semibold text-slate-900">Sign-off &amp; Acknowledgement (optional)</h2>
      </div>
      <div className="card-body grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div>
          <div className="input-label">Advisor / Senior Technician</div>
          {senior ? (
            <p className="text-slate-800">Signed by <span className="font-medium">{senior.typedName ?? 'signature on record'}</span> · {new Date(senior.signedAt).toLocaleString()}</p>
          ) : canSign ? (
            <SignInput placeholder="Type name to sign off" cta="Sign Off" onSubmit={onSignoff} />
          ) : (
            <p className="text-slate-400">Available once the inspection is completed.</p>
          )}
        </div>
        <div>
          <div className="input-label">Customer acknowledgement</div>
          {cust ? (
            <p className="text-slate-800">Acknowledged by <span className="font-medium">{cust.typedName ?? 'signature on record'}</span> · {new Date(cust.signedAt).toLocaleString()}</p>
          ) : canSign ? (
            <>
              <p className="text-[10.5px] text-slate-500 mb-1.5">
                &ldquo;I acknowledge that the conditions recorded above were presented to me. This
                acknowledgement does not by itself authorize additional repairs.&rdquo;
              </p>
              <SignInput placeholder="Customer name" cta="Record" onSubmit={onAck} />
            </>
          ) : (
            <p className="text-slate-400">Available once the inspection is completed.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function SignInput({ placeholder, cta, onSubmit }: { placeholder: string; cta: string; onSubmit: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className="flex gap-2">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} className="input-field text-xs flex-grow" />
      <button onClick={() => name.trim() && onSubmit(name.trim())} className="btn-secondary text-xs">{cta}</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Pre-Inspection — photo-first
// ---------------------------------------------------------------------------

const NO_PHOTO_REASONS = [
  ['CAMERA_UNAVAILABLE', 'Camera unavailable'],
  ['CUSTOMER_DECLINED', 'Customer declined photograph'],
  ['IMAGE_NOT_REQUIRED', 'Image not required'],
  ['OTHER', 'Other'],
] as const;

function PreInspectionView({ inspection }: { inspection: Inspection }) {
  const qc = useQueryClient();
  const router = useRouter();
  const editable = inspection.status === 'DRAFT';
  const invalidate = () => qc.invalidateQueries({ queryKey: ['inspection', inspection.id] });

  const [form, setForm] = useState({
    generalCondition: inspection.generalCondition ?? '',
    visibleDamage: inspection.visibleDamage,
    damageNotes: inspection.damageNotes ?? '',
    itemsLeftInside: inspection.itemsLeftInside ?? '',
    warningLights: inspection.warningLights ?? '',
    fuelLevelNote: inspection.fuelLevelNote ?? '',
    odometerReading: inspection.odometerReading,
  });
  const [dirty, setDirty] = useState(false);
  const [noPhotoDialog, setNoPhotoDialog] = useState(false);
  const [noPhotoReason, setNoPhotoReason] = useState<string>('CAMERA_UNAVAILABLE');
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: (extra?: Record<string, unknown>) =>
      api.patch(`/inspections/${inspection.id}`, {
        generalCondition: form.generalCondition,
        visibleDamage: form.visibleDamage ?? undefined,
        damageNotes: form.damageNotes,
        itemsLeftInside: form.itemsLeftInside,
        warningLights: form.warningLights,
        fuelLevelNote: form.fuelLevelNote,
        odometerReading: form.odometerReading ?? undefined,
        ...extra,
      }),
    onSuccess: () => { setDirty(false); invalidate(); },
  });
  const complete = useMutation({
    mutationFn: () => api.post(`/inspections/${inspection.id}/complete`, {}),
    onSuccess: invalidate,
  });
  const skip = useMutation({
    mutationFn: (reason: string) => api.post(`/inspections/${inspection.id}/skip`, { reason }),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/inspections/${inspection.id}/cancel`, {}),
    onSuccess: () => router.push('/inspections'),
  });

  const onComplete = async () => {
    if (inspection.photos.length === 0) {
      setNoPhotoDialog(true);
      return;
    }
    if (dirty) await save.mutateAsync(undefined);
    complete.mutate();
  };

  const confirmNoPhoto = async () => {
    // The reason rides the same draft update, then completion proceeds.
    await save.mutateAsync({ noPhotoReason });
    setNoPhotoDialog(false);
    complete.mutate();
  };

  const v = inspection.vehicle;
  const c = inspection.customer;

  return (
    <div className="page-container max-w-2xl">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Link href="/inspections" className="text-xs text-blue-600 hover:underline">← Inspections</Link>
          <span className="badge bg-cyan-50 text-cyan-700 text-[11px]">Pre-Inspection</span>
          <span className="badge bg-slate-100 text-slate-600 text-[11px]">{STATUS_LABEL[inspection.status] ?? inspection.status}</span>
          {dirty && <span className="text-[11px] text-amber-600">Unsaved changes</span>}
        </div>
        {editable && (
          <div className="flex gap-2">
            <button
              onClick={() => {
                const reason = prompt('Mark this pre-inspection as deliberately skipped. Reason:');
                if (reason?.trim()) skip.mutate(reason.trim());
              }}
              className="btn-secondary text-xs"
            >
              Skip
            </button>
            <button
              onClick={() => confirm('Cancel this record? Only for records created in error.') && cancel.mutate()}
              className="btn-secondary text-xs text-red-600"
            >
              Cancel Record
            </button>
          </div>
        )}
      </div>

      {/* Vehicle summary */}
      <div className="card p-4 mb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="text-sm font-semibold text-slate-900">
              {v ? `${v.modelYear ?? ''} ${v.make ?? ''} ${v.model ?? ''}`.trim() : 'Vehicle'} · {v?.plateNumber ?? '—'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {c ? `${c.firstName} ${c.lastName}` : ''} · {inspection.inspectionNumber} · {new Date(inspection.createdAt).toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Photo-first */}
      <PhotoSection inspection={inspection} editable={editable} onChanged={invalidate} />

      {/* Condition record */}
      <div className="card mt-4">
        <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Condition on arrival</h2></div>
        <div className="card-body space-y-3 text-xs">
          <label className="block">
            <span className="input-label">General vehicle condition</span>
            <textarea value={form.generalCondition} onChange={(e) => set('generalCondition', e.target.value)}
              disabled={!editable} rows={2} className="input-field text-xs" />
          </label>

          <div>
            <span className="input-label">Visible damage observed</span>
            <div className="flex gap-2 mt-1">
              {([['No', false], ['Yes', true]] as const).map(([label, val]) => {
                const on = form.visibleDamage === val;
                return (
                  <button key={label} type="button" disabled={!editable}
                    onClick={() => set('visibleDamage', on ? null : val)}
                    className={`flex-grow py-2.5 rounded-md border text-sm font-semibold ${
                      on
                        ? val
                          ? 'border-red-300 bg-red-50 text-red-700'
                          : 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-slate-300 bg-white text-slate-600'
                    }`}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {form.visibleDamage === true && (
            <label className="block">
              <span className="input-label">Damage / condition notes</span>
              <textarea value={form.damageNotes} onChange={(e) => set('damageNotes', e.target.value)}
                disabled={!editable} rows={2} className="input-field text-xs" />
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="input-label">Fuel level (optional)</span>
              <input value={form.fuelLevelNote} onChange={(e) => set('fuelLevelNote', e.target.value)}
                disabled={!editable} placeholder="e.g. half" className="input-field text-xs" />
            </label>
            <label className="block">
              <span className="input-label">Odometer (optional)</span>
              <input type="number" value={form.odometerReading ?? ''} disabled={!editable}
                onChange={(e) => set('odometerReading', e.target.value === '' ? null : Number(e.target.value))}
                className="input-field text-xs" />
            </label>
            <label className="block">
              <span className="input-label">Warning lights visible (optional)</span>
              <input value={form.warningLights} onChange={(e) => set('warningLights', e.target.value)}
                disabled={!editable} placeholder="e.g. check engine" className="input-field text-xs" />
            </label>
            <label className="block">
              <span className="input-label">Items left inside (optional)</span>
              <input value={form.itemsLeftInside} onChange={(e) => set('itemsLeftInside', e.target.value)}
                disabled={!editable} className="input-field text-xs" />
            </label>
          </div>
        </div>
      </div>

      {(save.isError || complete.isError) && (
        <p className="text-xs text-red-600 mt-3">{errText(save.error ?? complete.error, 'Could not save.')}</p>
      )}

      {editable && (
        <div className="sticky bottom-0 mt-4 -mx-4 px-4 py-3 bg-white border-t border-slate-200 shadow-[0_-1px_3px_rgba(15,23,42,0.08)] flex gap-2">
          <button onClick={() => save.mutate(undefined)} disabled={save.isPending} className="btn-secondary text-sm flex-grow">
            {save.isPending ? 'Saving…' : 'Save Draft'}
          </button>
          <button onClick={onComplete} disabled={complete.isPending} className="btn-primary text-sm flex-grow">
            Complete
          </button>
        </div>
      )}

      {/* No-photo confirmation */}
      {noPhotoDialog && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center">
          <div className="card w-full max-w-sm mx-4">
            <div className="card-body space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">No image has been attached</h3>
              <p className="text-xs text-slate-600">
                Complete this pre-inspection without photographic evidence? A reason is recorded.
              </p>
              <select value={noPhotoReason} onChange={(e) => setNoPhotoReason(e.target.value)} className="input-field text-xs">
                {NO_PHOTO_REASONS.map(([v2, l]) => (
                  <option key={v2} value={v2}>{l}</option>
                ))}
              </select>
              <div className="flex justify-end gap-2">
                <button onClick={() => setNoPhotoDialog(false)} className="btn-secondary text-xs">Go back</button>
                <button onClick={confirmNoPhoto} className="btn-primary text-xs">Complete without photo</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
