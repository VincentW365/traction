'use client';

/**
 * CR-2026-097 — global record search in the topbar.
 *
 * One box for whatever identifier staff are holding: a name, phone number,
 * licence plate, VIN, visit/ticket number, inspection number, or job-sheet
 * number (JS-…). Typed results with enough context to pick the right one;
 * selecting navigates straight to the record.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api-client';
import { useAuth } from '../hooks/use-auth';

interface SearchResults {
  query: string;
  customers: Array<{ id: string; name: string; customerNumber: string; phone: string | null }>;
  vehicles: Array<{ id: string; label: string; plateNumber: string; owner: { id: string; name: string } | null }>;
  visits: Array<{ id: string; visitNumber: string | null; status: string; visitedAt: string; customer: string; vehicle: string }>;
  inspections: Array<{ id: string; inspectionNumber: string; kind: string; status: string; createdAt: string; serviceVisitId: string }>;
}

function fmtD(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function GlobalSearch() {
  const router = useRouter();
  // CR-2026-102 §8 — results adapt to the role: technicians get the
  // technician-safe vehicle view, and no Customer Directory rows at all
  // (that destination can only 403 for them).
  const { user } = useAuth();
  const isTechnician = user?.roleCode === 'TECHNICIAN';
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const q = useQuery<SearchResults>({
    queryKey: ['global-search', debounced],
    queryFn: () => api.get(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
    staleTime: 15_000,
  });

  const go = (href: string) => {
    setOpen(false);
    setTerm('');
    router.push(href);
  };

  const r = q.data;
  const hasResults =
    !!r &&
    (isTechnician ? 0 : r.customers.length) + r.vehicles.length + r.visits.length + r.inspections.length > 0;

  return (
    <div ref={boxRef} className="relative w-full max-w-md">
      <div className="relative">
        <svg className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          value={term}
          onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
          onFocus={() => term.trim().length >= 2 && setOpen(true)}
          placeholder="Search name, phone, plate, visit #, inspection #…"
          className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-slate-200 bg-slate-50 focus:bg-white focus:border-blue-300 focus:outline-none"
        />
      </div>

      {open && debounced.length >= 2 && (
        <div className="absolute z-40 mt-1 w-full sm:w-[28rem] bg-white rounded-lg shadow-xl border border-slate-200 max-h-[70vh] overflow-y-auto">
          {q.isLoading && <p className="px-4 py-3 text-sm text-slate-500">Searching…</p>}
          {q.data && !hasResults && <p className="px-4 py-3 text-sm text-slate-500">No records match “{q.data.query}”.</p>}

          {r && !isTechnician && r.customers.length > 0 && (
            <div className="py-1">
              <p className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Customers</p>
              {r.customers.map((c) => (
                <button key={c.id} onClick={() => go(`/customers/${c.id}`)} className="w-full text-left px-4 py-2 hover:bg-blue-50/50">
                  <p className="text-sm font-medium text-slate-900">{c.name}</p>
                  <p className="text-xs text-slate-500">{c.customerNumber}{c.phone ? ` · ${c.phone}` : ''}</p>
                </button>
              ))}
            </div>
          )}

          {r && r.vehicles.length > 0 && (
            <div className="py-1 border-t border-slate-100">
              <p className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Vehicles</p>
              {r.vehicles.map((v) => (
                <button key={v.id} onClick={() => go(isTechnician ? `/technician/vehicles/${v.id}` : `/vehicles/${v.id}`)} className="w-full text-left px-4 py-2 hover:bg-blue-50/50">
                  <p className="text-sm font-medium text-slate-900">{v.label} · <span className="font-mono">{v.plateNumber}</span></p>
                  {v.owner && <p className="text-xs text-slate-500">Owner: {v.owner.name}</p>}
                </button>
              ))}
            </div>
          )}

          {r && r.visits.length > 0 && (
            <div className="py-1 border-t border-slate-100">
              <p className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Visits</p>
              {r.visits.map((v) => (
                <button key={v.id} onClick={() => go(`/visits/${v.id}`)} className="w-full text-left px-4 py-2 hover:bg-blue-50/50">
                  <p className="text-sm font-medium text-slate-900">
                    {fmtD(v.visitedAt)} · <span className="font-mono">{v.visitNumber ?? '—'}</span> · {v.status.replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-slate-500">{v.customer} · {v.vehicle}</p>
                </button>
              ))}
            </div>
          )}

          {r && r.inspections.length > 0 && (
            <div className="py-1 border-t border-slate-100">
              <p className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Inspections</p>
              {r.inspections.map((i) => (
                <button key={i.id} onClick={() => go(`/inspections/${i.id}`)} className="w-full text-left px-4 py-2 hover:bg-blue-50/50">
                  <p className="text-sm font-medium text-slate-900">
                    {fmtD(i.createdAt)} · {i.kind === 'PRE_INSPECTION' ? 'Pre-Inspection' : 'Vehicle Inspection'} · {i.status.replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-slate-500 font-mono">{i.inspectionNumber}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
