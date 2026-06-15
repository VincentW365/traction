'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api } from '../../../../../lib/api-client';
import { LoadingState } from '../../../../../components/ui/loading-state';

interface InspItem { id: string; category: string; label: string; orderIndex: number; result: string; note: string | null }
interface Wheel { id: string; position: string; brakeLiningMm: number | null; tireTread32nds: number | null; wearPattern: string | null; tirePressureBeforePsi: number | null; tirePressureAfterPsi: number | null; rotorOrDrum: string | null }
interface Rec { id: string; severity: string; description: string; customerDecision: string }
interface Sig { id: string; role: string; type: string; typedName: string | null; imageData: string | null; signedAt: string }
interface Inspection {
  id: string; inspectionNumber: string; status: string;
  batteryTestResult: string | null; batteryFactoryCca: number | null; batteryActualCca: number | null;
  alignmentCheckNeeded: boolean; wheelBalanceNeeded: boolean; brakeInspectionPerformed: boolean;
  priorBodyDamageNotes: string | null; comments: string | null; createdAt: string;
  customer: { firstName: string; lastName: string; phone: string | null } | null;
  vehicle: { plateNumber: string; make: string | null; model: string | null; modelYear: number | null } | null;
  items: InspItem[]; wheelMeasurements: Wheel[]; recommendations: Rec[]; signatures: Sig[];
}

const WHEEL_ORDER = ['LEFT_FRONT', 'RIGHT_FRONT', 'LEFT_REAR', 'RIGHT_REAR'];
const RESULT_LABEL: Record<string, string> = { OK: 'OK', FUTURE: 'Future', IMMEDIATE: 'Immediate', NOT_APPLICABLE: 'N/A' };

export default function InspectionPrintPage() {
  const id = useParams().id as string;
  const { data: c, isLoading } = useQuery<Inspection>({
    queryKey: ['inspection', id],
    queryFn: () => api.get(`/inspections/${id}`),
    enabled: !!id,
  });

  if (isLoading || !c) return <div className="page-container"><LoadingState message="Loading inspection..." /></div>;

  const categories = [...new Set(c.items.map((i) => i.category))];
  const wheel = (pos: string) => c.wheelMeasurements.find((w) => w.position === pos);
  const sig = (role: string) => c.signatures.find((s) => s.role === role);

  return (
    <div className="max-w-3xl mx-auto p-6 text-sm text-slate-900">
      <style>{`@media print { aside { display: none !important; } .no-print { display: none !important; } @page { margin: 12mm; } }`}</style>

      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold">Visual Inspection Form</h1>
          <p className="text-xs text-slate-500">{c.inspectionNumber} · {new Date(c.createdAt).toLocaleDateString()}</p>
        </div>
        <button onClick={() => window.print()} className="btn-primary text-xs no-print">Print / Save as PDF</button>
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-1 mb-4 text-xs">
        <div><span className="text-slate-500">Customer:</span> {c.customer ? `${c.customer.firstName} ${c.customer.lastName}` : '—'}</div>
        <div><span className="text-slate-500">Vehicle:</span> {c.vehicle ? `${[c.vehicle.modelYear, c.vehicle.make, c.vehicle.model].filter(Boolean).join(' ')} (${c.vehicle.plateNumber})` : '—'}</div>
        <div><span className="text-slate-500">Status:</span> {c.status}</div>
        <div><span className="text-slate-500">Phone:</span> {c.customer?.phone ?? '—'}</div>
      </div>

      {categories.map((cat) => (
        <div key={cat} className="mb-3">
          <h2 className="font-semibold border-b border-slate-300 mb-1">{cat}</h2>
          <table className="w-full text-xs">
            <tbody>
              {c.items.filter((i) => i.category === cat).sort((a, b) => a.orderIndex - b.orderIndex).map((i) => (
                <tr key={i.id} className="border-b border-slate-100">
                  <td className="py-0.5 pr-2">{i.label}{i.note ? <span className="text-slate-500"> — {i.note}</span> : ''}</td>
                  <td className="py-0.5 w-20 text-right font-medium">{RESULT_LABEL[i.result] ?? i.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="mb-3">
        <h2 className="font-semibold border-b border-slate-300 mb-1">Brake &amp; Tire</h2>
        <table className="w-full text-xs">
          <thead><tr className="text-slate-500"><th className="text-left">Wheel</th><th>Lining (mm)</th><th>Tread (32nds)</th><th>Wear</th><th>PSI →</th><th>Rotor/Drum</th></tr></thead>
          <tbody>
            {WHEEL_ORDER.map((pos) => { const w = wheel(pos); return (
              <tr key={pos} className="border-b border-slate-100 text-center">
                <td className="text-left">{pos.replace('_', ' ')}</td>
                <td>{w?.brakeLiningMm ?? '—'}</td>
                <td>{w?.tireTread32nds ?? '—'}</td>
                <td>{w?.wearPattern ?? '—'}</td>
                <td>{w?.tirePressureBeforePsi ?? '—'} → {w?.tirePressureAfterPsi ?? '—'}</td>
                <td>{w?.rotorOrDrum ?? '—'}</td>
              </tr>
            ); })}
          </tbody>
        </table>
        <p className="text-xs mt-1">
          Battery: {c.batteryTestResult ?? '—'} (factory {c.batteryFactoryCca ?? '—'} / actual {c.batteryActualCca ?? '—'} CCA) ·
          {c.alignmentCheckNeeded ? ' Alignment needed ·' : ''}{c.wheelBalanceNeeded ? ' Balance needed ·' : ''}{!c.brakeInspectionPerformed ? ' Brake inspection not performed' : ''}
        </p>
      </div>

      {c.recommendations.length > 0 && (
        <div className="mb-3">
          <h2 className="font-semibold border-b border-slate-300 mb-1">Recommendations</h2>
          <ul className="text-xs space-y-0.5">
            {c.recommendations.map((r) => (
              <li key={r.id}>[{r.severity}] {r.description} — <span className="font-medium">{r.customerDecision}</span></li>
            ))}
          </ul>
        </div>
      )}

      {(c.priorBodyDamageNotes || c.comments) && (
        <div className="mb-3 text-xs">
          {c.priorBodyDamageNotes && <p><span className="font-semibold">Prior body damage:</span> {c.priorBodyDamageNotes}</p>}
          {c.comments && <p><span className="font-semibold">Comments:</span> {c.comments}</p>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-8 mt-6 pt-4 border-t border-slate-300 text-xs">
        <div>
          <div className="h-12">{sig('SENIOR_TECH')?.typedName ? <span className="italic">{sig('SENIOR_TECH')!.typedName}</span> : ''}</div>
          <div className="border-t border-slate-400 pt-1">Senior Technician {sig('SENIOR_TECH') ? `· ${new Date(sig('SENIOR_TECH')!.signedAt).toLocaleDateString()}` : ''}</div>
        </div>
        <div>
          <div className="h-12">
            {sig('CUSTOMER')?.imageData ? <img src={sig('CUSTOMER')!.imageData!} alt="signature" className="h-12" /> : (sig('CUSTOMER')?.typedName ? <span className="italic">{sig('CUSTOMER')!.typedName}</span> : '')}
          </div>
          <div className="border-t border-slate-400 pt-1">Customer Acknowledgement {sig('CUSTOMER') ? `· ${new Date(sig('CUSTOMER')!.signedAt).toLocaleDateString()}` : ''}</div>
        </div>
      </div>
    </div>
  );
}
