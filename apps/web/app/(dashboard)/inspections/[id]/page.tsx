'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../components/status-badge';
import { SignaturePad } from '../../../../components/signature-pad';

interface InspItem { id: string; category: string; label: string; orderIndex: number; result: string; note: string | null }
interface Wheel { id: string; position: string; brakeLiningMm: number | null; tireTread32nds: number | null; wearPattern: string | null; tirePressureBeforePsi: number | null; tirePressureAfterPsi: number | null; rotorOrDrum: string | null }
interface Rec { id: string; severity: string; description: string; suggestedServiceTypeCode: string | null; customerDecision: string; inspectionItemId: string | null; resultingServiceOrderItemId: string | null }
interface Sig { id: string; role: string; type: string; typedName: string | null; imageData: string | null; signedAt: string }
interface TimelineRow { id: string; fromStatus: string | null; toStatus: string; changedAt: string; changedBy: { fullName: string } | null }
interface Inspection {
  id: string; inspectionNumber: string; status: string; templateVersion: number;
  batteryTestResult: string | null; batteryFactoryCca: number | null; batteryActualCca: number | null;
  alignmentCheckNeeded: boolean; wheelBalanceNeeded: boolean; brakeInspectionPerformed: boolean;
  priorBodyDamageNotes: string | null; comments: string | null;
  customer: { id: string; firstName: string; lastName: string } | null;
  vehicle: { id: string; plateNumber: string; make: string | null; model: string | null; modelYear: number | null } | null;
  serviceVisit: { id: string; status: string } | null;
  items: InspItem[]; wheelMeasurements: Wheel[]; recommendations: Rec[]; signatures: Sig[]; timeline: TimelineRow[];
}

interface ItemEdit { result: string; note: string }
interface WheelEdit { brakeLiningMm: string; tireTread32nds: string; wearPattern: string; tirePressureBeforePsi: string; tirePressureAfterPsi: string; rotorOrDrum: string }
interface EditState {
  items: Record<string, ItemEdit>;
  wheels: Record<string, WheelEdit>;
  batteryTestResult: string; batteryFactoryCca: string; batteryActualCca: string;
  alignmentCheckNeeded: boolean; wheelBalanceNeeded: boolean; brakeInspectionPerformed: boolean;
  priorBodyDamageNotes: string; comments: string;
}

const WHEEL_ORDER = ['LEFT_FRONT', 'RIGHT_FRONT', 'LEFT_REAR', 'RIGHT_REAR'];
const RESULTS: Array<{ v: string; label: string; on: string }> = [
  { v: 'OK', label: 'OK', on: 'bg-emerald-600 text-white' },
  { v: 'FUTURE', label: 'Future', on: 'bg-amber-500 text-white' },
  { v: 'IMMEDIATE', label: 'Immediate', on: 'bg-red-600 text-white' },
  { v: 'NOT_APPLICABLE', label: 'N/A', on: 'bg-slate-500 text-white' },
];

function seedFrom(d: Inspection): EditState {
  const items: Record<string, ItemEdit> = {};
  for (const it of d.items) items[it.id] = { result: it.result, note: it.note ?? '' };
  const wheels: Record<string, WheelEdit> = {};
  for (const w of d.wheelMeasurements) {
    wheels[w.position] = {
      brakeLiningMm: w.brakeLiningMm?.toString() ?? '',
      tireTread32nds: w.tireTread32nds?.toString() ?? '',
      wearPattern: w.wearPattern ?? '',
      tirePressureBeforePsi: w.tirePressureBeforePsi?.toString() ?? '',
      tirePressureAfterPsi: w.tirePressureAfterPsi?.toString() ?? '',
      rotorOrDrum: w.rotorOrDrum ?? '',
    };
  }
  return {
    items, wheels,
    batteryTestResult: d.batteryTestResult ?? '',
    batteryFactoryCca: d.batteryFactoryCca?.toString() ?? '',
    batteryActualCca: d.batteryActualCca?.toString() ?? '',
    alignmentCheckNeeded: d.alignmentCheckNeeded,
    wheelBalanceNeeded: d.wheelBalanceNeeded,
    brakeInspectionPerformed: d.brakeInspectionPerformed,
    priorBodyDamageNotes: d.priorBodyDamageNotes ?? '',
    comments: d.comments ?? '',
  };
}

const numOrUndef = (s: string) => (s.trim() === '' ? undefined : Number(s));

export default function InspectionDetailPage() {
  const id = useParams().id as string;
  const qc = useQueryClient();
  const { user } = useAuth();
  const role = user?.roleCode ?? '';
  const canEdit = ['ADMIN', 'MANAGER', 'SERVICE_ADVISOR', 'TECHNICIAN'].includes(role);
  const canSignoff = ['ADMIN', 'MANAGER'].includes(role);
  const canDecision = ['ADMIN', 'MANAGER', 'SERVICE_ADVISOR', 'FRONT_DESK'].includes(role);

  const { data, isLoading, error } = useQuery<Inspection>({
    queryKey: ['inspection', id],
    queryFn: () => api.get(`/inspections/${id}`),
    enabled: !!id,
  });

  const [edits, setEdits] = useState<EditState | null>(null);
  useEffect(() => { if (data) setEdits((prev) => prev ?? seedFrom(data)); }, [data]);

  // add-recommendation form
  const [recSeverity, setRecSeverity] = useState('FUTURE');
  const [recDesc, setRecDesc] = useState('');
  const [recItemId, setRecItemId] = useState('');
  const [recCode, setRecCode] = useState('');
  // sign-off
  const [signoffName, setSignoffName] = useState('');
  // customer sign-off
  const [custMethod, setCustMethod] = useState<'DRAWN' | 'TYPED'>('DRAWN');
  const [custTypedName, setCustTypedName] = useState('');
  const [custImage, setCustImage] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['inspection', id] });

  const save = useMutation({
    mutationFn: () => api.patch(`/inspections/${id}`, {
      batteryTestResult: edits!.batteryTestResult || undefined,
      batteryFactoryCca: numOrUndef(edits!.batteryFactoryCca),
      batteryActualCca: numOrUndef(edits!.batteryActualCca),
      alignmentCheckNeeded: edits!.alignmentCheckNeeded,
      wheelBalanceNeeded: edits!.wheelBalanceNeeded,
      brakeInspectionPerformed: edits!.brakeInspectionPerformed,
      priorBodyDamageNotes: edits!.priorBodyDamageNotes || undefined,
      comments: edits!.comments || undefined,
      items: Object.entries(edits!.items).map(([itemId, e]) => ({ itemId, result: e.result, note: e.note || undefined })),
      wheels: Object.entries(edits!.wheels).map(([position, w]) => ({
        position,
        brakeLiningMm: numOrUndef(w.brakeLiningMm), tireTread32nds: numOrUndef(w.tireTread32nds),
        wearPattern: w.wearPattern || undefined, tirePressureBeforePsi: numOrUndef(w.tirePressureBeforePsi),
        tirePressureAfterPsi: numOrUndef(w.tirePressureAfterPsi), rotorOrDrum: w.rotorOrDrum || undefined,
      })),
    }),
    onSuccess: invalidate,
  });
  const addRec = useMutation({
    mutationFn: () => api.post(`/inspections/${id}/recommendations`, { severity: recSeverity, description: recDesc.trim(), inspectionItemId: recItemId || undefined, suggestedServiceTypeCode: recCode || undefined }),
    onSuccess: () => { setRecDesc(''); setRecItemId(''); setRecCode(''); invalidate(); },
  });
  const complete = useMutation({ mutationFn: () => api.post(`/inspections/${id}/complete`, {}), onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: () => api.post(`/inspections/${id}/cancel`, {}), onSuccess: invalidate });
  const signoff = useMutation({ mutationFn: () => api.post(`/inspections/${id}/signoff`, { typedName: signoffName.trim() }), onSuccess: () => { setSignoffName(''); invalidate(); } });
  const decide = useMutation({
    mutationFn: (v: { rid: string; decision: string }) => api.patch(`/inspections/${id}/recommendations/${v.rid}/decision`, { decision: v.decision }),
    onSuccess: invalidate,
  });
  const toWorkOrder = useMutation({
    mutationFn: (rid: string) => api.post(`/inspections/${id}/recommendations/${rid}/to-work-order`, {}),
    onSuccess: invalidate,
  });
  const customerSignoff = useMutation({
    mutationFn: () => api.post(`/inspections/${id}/customer-signoff`, custMethod === 'DRAWN' ? { type: 'DRAWN', imageData: custImage } : { type: 'TYPED', typedName: custTypedName.trim() }),
    onSuccess: invalidate,
  });

  if (isLoading || !data) return <div className="page-container"><LoadingState message="Loading inspection..." /></div>;
  if (error) return (
    <div className="page-container">
      <PageHeader title="Inspection" breadcrumbs={[{ label: 'Inspections', href: '/inspections' }, { label: 'Error' }]} />
      <div className="card p-6 text-center border-red-200 bg-red-50"><p className="text-sm text-red-700">{(error as Error).message}</p></div>
    </div>
  );

  const c = data;
  const isDraft = c.status === 'DRAFT';
  const categories = [...new Set(c.items.map((i) => i.category))];
  const setItem = (itemId: string, patch: Partial<ItemEdit>) => setEdits((e) => e && ({ ...e, items: { ...e.items, [itemId]: { ...e.items[itemId], ...patch } } }));
  const setWheel = (pos: string, patch: Partial<WheelEdit>) => setEdits((e) => e && ({ ...e, wheels: { ...e.wheels, [pos]: { ...e.wheels[pos], ...patch } } }));

  return (
    <div className="page-container">
      <PageHeader
        title={c.inspectionNumber}
        breadcrumbs={[{ label: 'Inspections', href: '/inspections' }, { label: c.inspectionNumber }]}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={c.status} />
            <Link href={`/inspections/${id}/print`} className="btn-secondary text-xs">Print</Link>
          </div>
        }
      />

      <div className="card mb-5"><div className="card-body grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
        <div><div className="input-label">Customer</div>{c.customer ? <Link href={`/customers/${c.customer.id}`} className="text-blue-600 hover:underline">{c.customer.firstName} {c.customer.lastName}</Link> : '—'}</div>
        <div><div className="input-label">Vehicle</div>{c.vehicle ? <Link href={`/vehicles/${c.vehicle.id}`} className="text-blue-600 hover:underline">{c.vehicle.plateNumber}</Link> : '—'}</div>
        <div><div className="input-label">Template</div>v{c.templateVersion}</div>
        <div><div className="input-label">Visit</div>{c.serviceVisit?.status ?? '—'}</div>
      </div></div>

      {/* ── Checklist ── */}
      {edits && categories.map((cat) => (
        <div key={cat} className="card mb-4">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">{cat}</h2></div>
          <div className="card-body space-y-2">
            {c.items.filter((i) => i.category === cat).sort((a, b) => a.orderIndex - b.orderIndex).map((i) => (
              <div key={i.id} className="flex flex-col sm:flex-row sm:items-center gap-2 border-b border-slate-50 pb-2">
                <div className="flex-1 text-sm text-slate-700">{i.label}</div>
                <div className="flex items-center gap-1">
                  {RESULTS.map((r) => (
                    <button key={r.v} type="button" disabled={!isDraft}
                      onClick={() => setItem(i.id, { result: r.v })}
                      className={`text-[11px] px-2 py-1 rounded border ${edits.items[i.id]?.result === r.v ? r.on + ' border-transparent' : 'bg-white text-slate-500 border-slate-200'} ${isDraft ? '' : 'opacity-70 cursor-default'}`}>
                      {r.label}
                    </button>
                  ))}
                </div>
                {isDraft && (
                  <input value={edits.items[i.id]?.note ?? ''} onChange={(e) => setItem(i.id, { note: e.target.value })} placeholder="note" className="input-field text-xs w-full sm:w-44" />
                )}
                {!isDraft && i.note && <span className="text-xs text-slate-400">{i.note}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ── Brake & Tire + Battery + flags ── */}
      {edits && (
        <div className="card mb-4">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Brake &amp; Tire</h2></div>
          <div className="card-body overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500"><tr><th className="text-left">Wheel</th><th>Lining mm</th><th>Tread 32nds</th><th>Wear</th><th>PSI before</th><th>PSI after</th><th>Rotor/Drum</th></tr></thead>
              <tbody>
                {WHEEL_ORDER.map((pos) => {
                  const w = edits.wheels[pos];
                  if (!w) return null;
                  const cell = (k: keyof WheelEdit, type = 'number') => (
                    <td className="p-1">
                      {k === 'rotorOrDrum' ? (
                        <select disabled={!isDraft} value={w.rotorOrDrum} onChange={(e) => setWheel(pos, { rotorOrDrum: e.target.value })} className="input-field text-xs w-20">
                          <option value="">—</option><option value="ROTOR">Rotor</option><option value="DRUM">Drum</option>
                        </select>
                      ) : (
                        <input disabled={!isDraft} type={type} value={w[k]} onChange={(e) => setWheel(pos, { [k]: e.target.value } as Partial<WheelEdit>)} className="input-field text-xs w-20" />
                      )}
                    </td>
                  );
                  return (
                    <tr key={pos}><td className="text-left whitespace-nowrap">{pos.replace('_', ' ')}</td>
                      {cell('brakeLiningMm')}{cell('tireTread32nds')}{cell('wearPattern', 'text')}{cell('tirePressureBeforePsi')}{cell('tirePressureAfterPsi')}{cell('rotorOrDrum')}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              <div><label className="input-label">Battery test</label>
                <select disabled={!isDraft} value={edits.batteryTestResult} onChange={(e) => setEdits((x) => x && ({ ...x, batteryTestResult: e.target.value }))} className="input-field text-xs">
                  <option value="">—</option><option value="PASS">Pass</option><option value="RECHARGE_RETEST">Recharge &amp; retest</option><option value="FAIL">Fail</option>
                </select>
              </div>
              <div><label className="input-label">Factory CCA</label><input disabled={!isDraft} type="number" value={edits.batteryFactoryCca} onChange={(e) => setEdits((x) => x && ({ ...x, batteryFactoryCca: e.target.value }))} className="input-field text-xs" /></div>
              <div><label className="input-label">Actual CCA</label><input disabled={!isDraft} type="number" value={edits.batteryActualCca} onChange={(e) => setEdits((x) => x && ({ ...x, batteryActualCca: e.target.value }))} className="input-field text-xs" /></div>
            </div>
            <div className="flex flex-wrap gap-4 mt-3 text-xs">
              <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!isDraft} checked={edits.alignmentCheckNeeded} onChange={(e) => setEdits((x) => x && ({ ...x, alignmentCheckNeeded: e.target.checked }))} /> Alignment check needed</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!isDraft} checked={edits.wheelBalanceNeeded} onChange={(e) => setEdits((x) => x && ({ ...x, wheelBalanceNeeded: e.target.checked }))} /> Wheel balance needed</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!isDraft} checked={edits.brakeInspectionPerformed} onChange={(e) => setEdits((x) => x && ({ ...x, brakeInspectionPerformed: e.target.checked }))} /> Brake inspection performed</label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <div><label className="input-label">Prior body damage notes</label><textarea disabled={!isDraft} rows={2} value={edits.priorBodyDamageNotes} onChange={(e) => setEdits((x) => x && ({ ...x, priorBodyDamageNotes: e.target.value }))} className="input-field text-xs" /></div>
              <div><label className="input-label">Comments</label><textarea disabled={!isDraft} rows={2} value={edits.comments} onChange={(e) => setEdits((x) => x && ({ ...x, comments: e.target.value }))} className="input-field text-xs" /></div>
            </div>
          </div>
        </div>
      )}

      {/* ── Recommendations ── */}
      <div className="card mb-4">
        <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Recommendations</h2></div>
        <div className="card-body space-y-2">
          {c.recommendations.length === 0 && <p className="text-sm text-slate-500">No recommendations.</p>}
          {c.recommendations.map((r) => (
            <div key={r.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-50 pb-2">
              <div className="text-sm text-slate-700">
                <span className={`badge mr-2 ${r.severity === 'IMMEDIATE' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>{r.severity}</span>
                {r.description}{r.suggestedServiceTypeCode ? <span className="text-xs text-slate-400 ml-1">({r.suggestedServiceTypeCode})</span> : ''}
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1">
                  {c.status === 'SIGNED_OFF' && canDecision ? (
                    ['APPROVED', 'DECLINED', 'DEFERRED'].map((d) => (
                      <button key={d} onClick={() => decide.mutate({ rid: r.id, decision: d })} disabled={decide.isPending}
                        className={`text-[11px] px-2 py-1 rounded border ${r.customerDecision === d ? 'bg-blue-600 text-white border-transparent' : 'bg-white text-slate-500 border-slate-200'}`}>{d}</button>
                    ))
                  ) : (
                    <span className="badge bg-slate-100 text-slate-600">{r.customerDecision}</span>
                  )}
                </div>
                {r.customerDecision === 'APPROVED' && (c.status === 'SIGNED_OFF' || c.status === 'CLOSED') && canDecision && (
                  r.resultingServiceOrderItemId
                    ? <span className="text-[11px] text-emerald-600">✓ In work order</span>
                    : <button onClick={() => toWorkOrder.mutate(r.id)} disabled={toWorkOrder.isPending} className="text-[11px] text-blue-600 hover:underline">Add to work order</button>
                )}
              </div>
            </div>
          ))}
          {isDraft && canEdit && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-2">
              <select value={recSeverity} onChange={(e) => setRecSeverity(e.target.value)} className="input-field text-xs"><option value="FUTURE">Future</option><option value="IMMEDIATE">Immediate</option></select>
              <input value={recDesc} onChange={(e) => setRecDesc(e.target.value)} placeholder="Finding / recommendation" className="input-field text-xs sm:col-span-2" />
              <input value={recCode} onChange={(e) => setRecCode(e.target.value)} placeholder="Service code (optional)" className="input-field text-xs" />
              <button onClick={() => addRec.mutate()} disabled={!recDesc.trim() || addRec.isPending} className="btn-secondary text-xs sm:col-span-4 w-fit">Add recommendation</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Actions by status ── */}
      {isDraft && canEdit && (
        <div className="flex items-center gap-2 mb-6">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">{save.isPending ? 'Saving...' : 'Save'}</button>
          <button onClick={() => complete.mutate()} disabled={complete.isPending} className="btn-success text-sm">Mark Completed</button>
          <button onClick={() => cancel.mutate()} disabled={cancel.isPending} className="btn-secondary text-sm">Cancel inspection</button>
          {(save.isError || complete.isError) && <span className="text-xs text-red-600">{((save.error || complete.error) as Error)?.message}</span>}
        </div>
      )}

      {c.status === 'COMPLETED' && (
        <div className="card mb-6">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Senior technician sign-off</h2></div>
          <div className="card-body space-y-3">
            {canSignoff ? (
              <>
                <div><label className="input-label">Typed acknowledgment (your name)</label><input value={signoffName} onChange={(e) => setSignoffName(e.target.value)} className="input-field text-sm max-w-sm" /></div>
                {signoff.isError && <p className="text-xs text-red-600">{(signoff.error as Error).message}</p>}
                <div className="flex gap-2">
                  <button onClick={() => signoff.mutate()} disabled={!signoffName.trim() || signoff.isPending} className="btn-primary text-sm">{signoff.isPending ? 'Signing...' : 'Sign off'}</button>
                  {canEdit && <button onClick={() => cancel.mutate()} disabled={cancel.isPending} className="btn-secondary text-sm">Cancel inspection</button>}
                </div>
              </>
            ) : <p className="text-sm text-slate-500">Awaiting senior technician (manager) sign-off.</p>}
          </div>
        </div>
      )}

      {c.status === 'SIGNED_OFF' && (
        <div className="card mb-6">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Customer review &amp; sign-off</h2></div>
          <div className="card-body space-y-3">
            {canDecision ? (
              <>
                <p className="text-xs text-slate-500">Record the customer&apos;s decision on each recommendation above, then capture their signature.</p>
                <div className="flex items-center gap-3 text-xs">
                  <label className="flex items-center gap-1"><input type="radio" checked={custMethod === 'DRAWN'} onChange={() => setCustMethod('DRAWN')} /> Drawn</label>
                  <label className="flex items-center gap-1"><input type="radio" checked={custMethod === 'TYPED'} onChange={() => setCustMethod('TYPED')} /> Typed</label>
                </div>
                {custMethod === 'DRAWN'
                  ? <SignaturePad onChange={setCustImage} />
                  : <input value={custTypedName} onChange={(e) => setCustTypedName(e.target.value)} placeholder="Customer name" className="input-field text-sm max-w-sm" />}
                {customerSignoff.isError && <p className="text-xs text-red-600">{(customerSignoff.error as Error).message}</p>}
                <button
                  onClick={() => customerSignoff.mutate()}
                  disabled={customerSignoff.isPending || (custMethod === 'DRAWN' ? !custImage : !custTypedName.trim())}
                  className="btn-primary text-sm">
                  {customerSignoff.isPending ? 'Saving...' : 'Customer sign-off & close'}
                </button>
              </>
            ) : <p className="text-sm text-slate-500">Awaiting customer sign-off.</p>}
          </div>
        </div>
      )}

      {/* ── Signatures (when present) ── */}
      {c.signatures.length > 0 && (
        <div className="card mb-6"><div className="card-body grid grid-cols-2 gap-6 text-xs">
          {['SENIOR_TECH', 'CUSTOMER'].map((roleKey) => {
            const s = c.signatures.find((x) => x.role === roleKey);
            return (
              <div key={roleKey}>
                <div className="input-label">{roleKey === 'SENIOR_TECH' ? 'Senior Technician' : 'Customer'}</div>
                <div className="h-12 flex items-end">
                  {s?.imageData ? <img src={s.imageData} alt="signature" className="h-12" /> : <span className="italic text-slate-700">{s?.typedName ?? '—'}</span>}
                </div>
                {s && <div className="text-slate-400 mt-1">{new Date(s.signedAt).toLocaleString()}</div>}
              </div>
            );
          })}
        </div></div>
      )}

      {/* ── Timeline ── */}
      <div className="card">
        <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">History</h2></div>
        <div className="card-body">
          <ol className="space-y-2 text-xs">
            {c.timeline.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                <span className="font-medium text-slate-700">{t.fromStatus ? `${t.fromStatus} → ${t.toStatus}` : t.toStatus}</span>
                <span className="text-slate-400">{new Date(t.changedAt).toLocaleString()}{t.changedBy ? ` · ${t.changedBy.fullName}` : ''}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
