'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
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
  } | null;
  queueTicket: { ticketNumber: string } | null;
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

function Line({ label, value, grow = 1 }: { label: string; value?: string | null; grow?: number }) {
  return (
    <div className="flex items-baseline gap-1.5 min-w-0" style={{ flexGrow: grow }}>
      <span className="text-[11px] font-extrabold text-slate-900 whitespace-nowrap">{label}</span>
      <span className="border-b border-slate-900 flex-grow px-1 text-[11px] text-slate-900 min-h-[16px] truncate">
        {value ?? ''}
      </span>
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
  const [pair, setPair] = useState<Record<string, boolean>>({}); // ATM/MTM, 4WD/2WD, fuel
  const [directive, setDirective] = useState('');
  const [initialised, setInitialised] = useState(false);

  const d = q.data;

  // Pre-tick from the real order once, then leave the person in charge.
  if (d && !initialised) {
    setInitialised(true);
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
  const mechanic = d.serviceOrders[0]?.assignments[0]?.technician?.userAccount?.fullName ?? '';
  const togglePair = (group: string[], key: string) =>
    setPair((p) => {
      const next = { ...p };
      // One per group, and clicking the ticked one clears it.
      const was = next[key];
      for (const g of group) delete next[g];
      if (!was) next[key] = true;
      return next;
    });

  return (
    <div className="page-container max-w-3xl">
      <div className="flex items-center justify-between mb-3 print:hidden">
        <Link href="/inspections" className="text-xs text-blue-600 hover:underline">← Inspections</Link>
        <button onClick={() => window.print()} className="btn-primary text-sm">Print</button>
      </div>

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
            <Line label="DATE:" value={new Date(d.createdAt).toLocaleDateString()} />
          </div>
        </div>
        {d.queueTicket && (
          <div className="text-[10px] text-slate-500 mt-0.5">Ticket {d.queueTicket.ticketNumber}</div>
        )}

        <SectionHeading>PERSONAL DATA</SectionHeading>
        <div className="flex flex-col gap-2.5 pt-3 px-0.5">
          <Line label="NAME:" value={c ? `${c.firstName} ${c.lastName}` : ''} />
          <div className="flex gap-3">
            <Line label="CONTACT NUMBER(S):" value={c?.phone} />
            <Line label="EMAIL ADDRESS:" value={c?.email} grow={1.6} />
          </div>
        </div>

        <SectionHeading>VEHICLE DETAILS</SectionHeading>
        <div className="flex flex-col gap-2.5 pt-3 px-0.5">
          <div className="flex gap-3">
            <Line label="YEAR:" value={v?.modelYear ? String(v.modelYear) : ''} grow={0.5} />
            <Line label="MAKE:" value={v?.make} />
            <Line label="MODEL:" value={v?.model} grow={1.4} />
          </div>
          <div className="flex gap-3">
            <Line label="LICENCE:" value={v?.plateNumber} />
            <Line label="ENGINE #:" value={v?.engineNo} />
            <Line label="CHASSIS #:" value={v?.vin} grow={1.3} />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Line label="MILEAGE:" value={d.mileageIn != null ? d.mileageIn.toLocaleString() : ''} grow={0.4} />
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
            <Line label="NEXT SERVICE MILEAGE:" grow={0.6} />
            <span className="text-[11px] font-extrabold text-slate-900">KM/ML</span>
            <Line label="DATE:" />
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
            <Line label="CUSTOMER NO.:" value={c?.customerNumber} />
            <Line label="PREPARED BY:" />
            <Line label="ASSIGNED MECHANIC:" value={mechanic} />
            <Line label="SALES INV. #:" />
          </div>
        </div>

        {/* Signature */}
        <div className="flex items-baseline justify-center gap-3 mt-6">
          <span className="text-[11px] font-extrabold text-slate-900">CUSTOMER&apos;S SIGNATURE:</span>
          <span className="border-b border-slate-900 w-52" />
          <span className="text-[11px] font-extrabold text-slate-900">DATE:</span>
          <span className="border-b border-slate-900 w-36" />
        </div>
      </div>

      <p className="text-[11px] text-slate-400 mt-3 print:hidden">
        Ticks and the directive are editable here and print as shown; blank lines stay blank for pen.
        Printing does not change the visit&apos;s booked services.
      </p>
    </div>
  );
}
