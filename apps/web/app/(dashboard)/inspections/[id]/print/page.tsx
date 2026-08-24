'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';

/**
 * CR-2026-093 — the printable inspection.
 *
 * Follows the on-screen document, stripped to paper: no controls, no navigation,
 * and never colour as the only signal — every result prints its letter (O/F/I/N)
 * and Not Inspected prints as a dash, so a black-and-white copy reads identically.
 */

interface PrintData {
  inspectionNumber: string;
  kind: string;
  status: string;
  createdAt: string;
  batteryTestResult: string | null;
  batteryFactoryCca: number | null;
  batteryActualCca: number | null;
  alignmentCheckNeeded: boolean;
  wheelBalanceNeeded: boolean;
  brakeInspectionPerformed: boolean;
  priorBodyDamageNotes: string | null;
  comments: string | null;
  customer: { firstName: string; lastName: string } | null;
  vehicle: { plateNumber: string; make: string | null; model: string | null; modelYear: number | null } | null;
  items: Array<{ id: string; category: string; label: string; result: string }>;
  wheelMeasurements: Array<{
    position: string;
    brakeLiningMm: number | null;
    tireTread32nds: number | null;
    wearPattern: string | null;
    tirePressureBeforePsi: number | null;
    tirePressureAfterPsi: number | null;
    rotorOrDrum: string | null;
  }>;
  recommendations: Array<{ id: string; severity: string; description: string; customerDecision: string }>;
  signatures: Array<{ id: string; role: string; typedName: string | null; signedAt: string }>;
}

const RESULT = {
  OK: { letter: 'O', text: 'Okay', bg: '#00a651', fg: '#fff' },
  FUTURE: { letter: 'F', text: 'Future attention', bg: '#ffd400', fg: '#0f172a' },
  IMMEDIATE: { letter: 'I', text: 'Immediate attention', bg: '#e02020', fg: '#fff' },
  NOT_APPLICABLE: { letter: 'N', text: 'Not applicable', bg: '#94a3b8', fg: '#fff' },
  NOT_INSPECTED: { letter: '—', text: 'Not inspected', bg: '#ffffff', fg: '#475569' },
} as const;

const WHEEL_LABEL: Record<string, string> = {
  LEFT_FRONT: 'Left Front', RIGHT_FRONT: 'Right Front', LEFT_REAR: 'Left Rear', RIGHT_REAR: 'Right Rear',
};

export default function InspectionPrintPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery<PrintData>({
    queryKey: ['inspection', id],
    queryFn: () => api.get(`/inspections/${id}`),
  });

  if (q.isLoading) return <div className="p-8 text-sm text-slate-500">Preparing…</div>;
  if (!q.data) return <div className="p-8 text-sm text-red-600">Could not load this inspection.</div>;
  const d = q.data;

  const grouped = new Map<string, PrintData['items']>();
  for (const it of d.items) {
    if (!grouped.has(it.category)) grouped.set(it.category, []);
    grouped.get(it.category)!.push(it);
  }

  return (
    <div className="max-w-[820px] mx-auto bg-white text-slate-900 p-8 print:p-0">
      <div className="flex justify-end mb-3 print:hidden">
        <button onClick={() => window.print()} className="btn-primary text-sm">Print</button>
      </div>

      {/* Letterhead */}
      <div className="flex items-center justify-between">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/berts-logo.png" alt="Bert's Auto Parts" className="h-12 w-auto" />
        <div className="text-[10px] text-slate-500 text-right">
          {d.inspectionNumber} · {new Date(d.createdAt).toLocaleDateString()}<br />
          Bert&apos;s Auto Parts Service Centre
        </div>
      </div>
      <h1 className="text-center text-lg font-extrabold tracking-wide mt-2">VISUAL VEHICLE INSPECTION REPORT</h1>
      <div className="h-[3px] bg-slate-900 mt-1 mb-3" />

      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-[11px] mb-3">
        <div><span className="font-bold">Customer:</span> {d.customer ? `${d.customer.firstName} ${d.customer.lastName}` : '—'}</div>
        <div><span className="font-bold">Vehicle:</span> {d.vehicle ? `${d.vehicle.modelYear ?? ''} ${d.vehicle.make ?? ''} ${d.vehicle.model ?? ''} · ${d.vehicle.plateNumber}`.trim() : '—'}</div>
        <div><span className="font-bold">Status:</span> {d.status.replace(/_/g, ' ').toLowerCase()}</div>
        <div><span className="font-bold">Completed:</span> {new Date(d.createdAt).toLocaleDateString()}</div>
      </div>

      {/* Result key first, so the letters are defined before they are used */}
      <div className="flex flex-wrap gap-4 border border-slate-400 px-3 py-1.5 mb-3 text-[10px]">
        <span className="font-extrabold tracking-wide">RESULT KEY</span>
        {Object.values(RESULT).map((r) => (
          <span key={r.letter} className="flex items-center gap-1">
            <span className="w-4 h-4 border border-slate-500 inline-flex items-center justify-center text-[9px] font-black"
              style={{ background: r.bg, color: r.fg }}>{r.letter}</span>
            {r.text}
          </span>
        ))}
      </div>

      {/* Checklist */}
      {[...grouped.entries()].map(([category, items]) => (
        <div key={category} className="break-inside-avoid">
          <div className="bg-slate-900 text-white text-[10.5px] font-extrabold tracking-widest uppercase px-2 py-0.5 print:bg-slate-900">
            {category}
          </div>
          {items.map((it) => {
            const r = RESULT[it.result as keyof typeof RESULT] ?? RESULT.NOT_INSPECTED;
            return (
              <div key={it.id} className="flex items-center gap-2 border-b border-slate-300 py-[3px]">
                <span className="w-5 h-5 border border-slate-500 inline-flex items-center justify-center text-[10px] font-black shrink-0"
                  style={{ background: r.bg, color: r.fg }}>{r.letter}</span>
                <span className="text-[10px] leading-tight flex-grow">{it.label}</span>
                <span className="text-[9px] text-slate-500 shrink-0">{r.text}</span>
              </div>
            );
          })}
        </div>
      ))}

      {/* Battery figures */}
      <div className="flex gap-6 text-[10.5px] mt-2">
        <span><span className="font-bold">Battery test:</span> {d.batteryTestResult ? d.batteryTestResult.replace(/_/g, ' ').toLowerCase() : '—'}</span>
        <span><span className="font-bold">Factory CCA:</span> {d.batteryFactoryCca ?? '—'}</span>
        <span><span className="font-bold">Actual CCA:</span> {d.batteryActualCca ?? '—'}</span>
      </div>

      {/* Wheels */}
      <div className="bg-slate-900 text-white text-[10.5px] font-extrabold tracking-widest uppercase px-2 py-0.5 mt-3">
        Brake and Tire
      </div>
      <table className="w-full text-[10px] border-collapse mt-1">
        <thead>
          <tr className="text-left">
            <th className="border border-slate-400 px-1.5 py-0.5">Wheel</th>
            <th className="border border-slate-400 px-1.5 py-0.5">Brake lining (mm)</th>
            <th className="border border-slate-400 px-1.5 py-0.5">Tread (32nds)</th>
            <th className="border border-slate-400 px-1.5 py-0.5">Wear pattern</th>
            <th className="border border-slate-400 px-1.5 py-0.5">PSI before → after</th>
            <th className="border border-slate-400 px-1.5 py-0.5">Rotor / drum</th>
          </tr>
        </thead>
        <tbody>
          {d.wheelMeasurements.map((w) => (
            <tr key={w.position}>
              <td className="border border-slate-400 px-1.5 py-0.5 font-bold">{WHEEL_LABEL[w.position]}</td>
              <td className="border border-slate-400 px-1.5 py-0.5">{w.brakeLiningMm ?? ''}</td>
              <td className="border border-slate-400 px-1.5 py-0.5">{w.tireTread32nds ?? ''}</td>
              <td className="border border-slate-400 px-1.5 py-0.5">{w.wearPattern ?? ''}</td>
              <td className="border border-slate-400 px-1.5 py-0.5">
                {w.tirePressureBeforePsi ?? ''}{w.tirePressureBeforePsi != null || w.tirePressureAfterPsi != null ? ' → ' : ''}{w.tirePressureAfterPsi ?? ''}
              </td>
              <td className="border border-slate-400 px-1.5 py-0.5">{w.rotorOrDrum ? (w.rotorOrDrum === 'ROTOR' ? 'Rotor' : 'Drum') : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-5 text-[10px] mt-1">
        <span>[{d.alignmentCheckNeeded ? '✓' : ' '}] Alignment check needed</span>
        <span>[{d.wheelBalanceNeeded ? '✓' : ' '}] Wheel balance needed</span>
        <span>[{!d.brakeInspectionPerformed ? '✓' : ' '}] Brake inspection not performed this visit</span>
      </div>

      {/* Damage + comments */}
      <div className="bg-slate-900 text-white text-[10.5px] font-extrabold tracking-widest uppercase px-2 py-0.5 mt-3">
        Prior Body Damage
      </div>
      <p className="text-[10.5px] min-h-[24px] border-b border-slate-300 py-1">{d.priorBodyDamageNotes ?? 'No prior damage recorded.'}</p>

      <div className="bg-slate-900 text-white text-[10.5px] font-extrabold tracking-widest uppercase px-2 py-0.5 mt-3">
        Comments / Estimates
      </div>
      <p className="text-[10.5px] min-h-[40px] whitespace-pre-line border-b border-slate-300 py-1">{d.comments ?? ''}</p>

      {/* Findings */}
      {d.recommendations.length > 0 && (
        <>
          <div className="bg-slate-900 text-white text-[10.5px] font-extrabold tracking-widest uppercase px-2 py-0.5 mt-3">
            Findings &amp; Recommendations
          </div>
          {d.recommendations.map((r) => (
            <div key={r.id} className="text-[10px] border-b border-slate-300 py-1 flex gap-2">
              <span className="font-black w-3">{r.severity === 'IMMEDIATE' ? 'I' : 'F'}</span>
              <span className="flex-grow">{r.description}</span>
              <span className="text-slate-500">{r.customerDecision.toLowerCase()}</span>
            </div>
          ))}
        </>
      )}

      {/* Signatures */}
      <div className="grid grid-cols-2 gap-10 mt-8 text-[10px]">
        {(['SENIOR_TECH', 'CUSTOMER'] as const).map((role) => {
          const sig = d.signatures.find((s) => s.role === role);
          return (
            <div key={role}>
              <div className="border-b border-slate-900 h-6 flex items-end px-1 text-[11px]">
                {sig?.typedName ?? ''}
              </div>
              <div className="font-bold mt-0.5">
                X&nbsp;&nbsp;{role === 'SENIOR_TECH' ? 'ADVISOR' : 'CUSTOMER ACKNOWLEDGEMENT'}
                {sig && <span className="font-normal text-slate-500"> · {new Date(sig.signedAt).toLocaleDateString()}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
