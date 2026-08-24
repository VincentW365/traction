'use client';

/**
 * CR-2026-097 — Service History table (Customer 360 + vehicle history).
 *
 * One shared component: the customer profile shows it across all vehicles with
 * a vehicle filter; the vehicle page pins it to that vehicle. Every row links
 * to the full Visit Record, and shows at a glance whether an inspection and a
 * job sheet exist for the visit.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../lib/api-client';
import { StatusBadge } from './status-badge';

const PAGE = 15;

interface HistoryItem {
  id: string;
  visitNumber: string | null;
  visitedAt: string;
  status: string;
  sourceType: string;
  mileageIn: number | null;
  vehicle: { id: string; plateNumber: string; label: string | null } | null;
  services: string[];
  inspections: Array<{ id: string; kind: string; status: string }>;
  hasJobSheet: boolean;
}

interface HistoryResponse { items: HistoryItem[]; total: number; limit: number; offset: number }

const VISIT_STATUSES = ['CLOSED', 'READY_FOR_PICKUP', 'IN_SERVICE', 'QUEUED', 'CHECKED_IN', 'ABANDONED', 'CANCELLED'];

export function VisitHistory(props: {
  customerId: string;
  /** Pin to one vehicle (vehicle page) — hides the vehicle filter. */
  vehicleId?: string;
  /** Vehicles for the filter dropdown (customer page). */
  vehicles?: Array<{ id: string; plateNumber: string; label?: string | null }>;
  /** Externally-controlled vehicle preselection (e.g. clicking a vehicle card). */
  selectedVehicleId?: string | null;
  onVehicleChange?: (vehicleId: string | null) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [internalVehicle, setInternalVehicle] = useState<string>('');

  const vehicleFilter = props.vehicleId ?? props.selectedVehicleId ?? (internalVehicle || null);

  const params = new URLSearchParams();
  params.set('limit', String(PAGE));
  params.set('offset', String(offset));
  if (vehicleFilter) params.set('vehicleId', vehicleFilter);
  if (status) params.set('status', status);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (q.trim()) params.set('q', q.trim());
  params.set('sort', sort);

  const historyQ = useQuery<HistoryResponse>({
    queryKey: ['service-history', props.customerId, params.toString()],
    queryFn: () => api.get(`/customers/${props.customerId}/service-history?${params.toString()}`),
    enabled: !!props.customerId,
  });

  const data = historyQ.data;
  const showVehicleColumn = !props.vehicleId;

  const resetPage = () => setOffset(0);

  return (
    <div className="card">
      <div className="card-header flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          Service History
          {data && <span className="ml-2 text-xs font-normal text-slate-400">{data.total} visit{data.total === 1 ? '' : 's'}</span>}
        </h2>
        <button
          onClick={() => { setSort(sort === 'newest' ? 'oldest' : 'newest'); resetPage(); }}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          {sort === 'newest' ? 'Newest first ↓' : 'Oldest first ↑'}
        </button>
      </div>

      {/* Filters */}
      <div className="px-5 py-2.5 border-b border-slate-100 flex flex-wrap items-center gap-2">
        {showVehicleColumn && (props.vehicles?.length ?? 0) > 1 && (
          <select
            value={props.selectedVehicleId ?? internalVehicle}
            onChange={(e) => {
              if (props.onVehicleChange) props.onVehicleChange(e.target.value || null);
              else setInternalVehicle(e.target.value);
              resetPage();
            }}
            className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white"
          >
            <option value="">All vehicles</option>
            {props.vehicles!.map((v) => (
              <option key={v.id} value={v.id}>{v.label ? `${v.label} — ${v.plateNumber}` : v.plateNumber}</option>
            ))}
          </select>
        )}
        <select value={status} onChange={(e) => { setStatus(e.target.value); resetPage(); }} className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white">
          <option value="">Any status</option>
          {VISIT_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); resetPage(); }} className="text-xs border border-slate-200 rounded-md px-2 py-1" />
        <span className="text-xs text-slate-400">to</span>
        <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); resetPage(); }} className="text-xs border border-slate-200 rounded-md px-2 py-1" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); resetPage(); }}
          placeholder="Search service, visit #, plate"
          className="text-xs border border-slate-200 rounded-md px-2 py-1 flex-1 min-w-[140px]"
        />
      </div>

      <div className="card-body p-0">
        {historyQ.isLoading ? (
          <p className="text-sm text-slate-500 px-5 py-4">Loading history…</p>
        ) : !data || data.items.length === 0 ? (
          <p className="text-sm text-slate-500 px-5 py-4">No visits match.</p>
        ) : (
          <div className="table-container border-0 shadow-none">
            <table className="w-full text-sm">
              <thead className="table-header">
                <tr>
                  <th>Date</th>
                  <th>Visit #</th>
                  {showVehicleColumn && <th>Vehicle</th>}
                  <th>Services</th>
                  <th>Records</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((v) => (
                  <tr key={v.id} className="table-row">
                    <td className="whitespace-nowrap text-slate-700">
                      {new Date(v.visitedAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="font-mono text-xs text-blue-600">
                      <Link href={`/visits/${v.id}`} className="hover:underline">{v.visitNumber ?? '—'}</Link>
                    </td>
                    {showVehicleColumn && (
                      <td className="text-xs text-slate-600">
                        {v.vehicle ? (
                          <Link href={`/vehicles/${v.vehicle.id}`} className="hover:underline">
                            {v.vehicle.label ?? v.vehicle.plateNumber}
                            <span className="text-slate-400 ml-1">{v.vehicle.plateNumber}</span>
                          </Link>
                        ) : '—'}
                      </td>
                    )}
                    <td className="text-xs text-slate-600 max-w-[220px]">
                      <span className="line-clamp-2">{v.services.length ? v.services.join(', ') : '—'}</span>
                    </td>
                    <td className="whitespace-nowrap">
                      {v.inspections.length > 0 && (
                        <span className="badge bg-indigo-50 text-indigo-700 text-[10px] mr-1" title={`${v.inspections.length} inspection(s)`}>
                          Insp{v.inspections.length > 1 ? ` ×${v.inspections.length}` : ''}
                        </span>
                      )}
                      {v.hasJobSheet && <span className="badge bg-amber-50 text-amber-700 text-[10px]">Job Sheet</span>}
                      {v.inspections.length === 0 && !v.hasJobSheet && <span className="text-xs text-slate-300">—</span>}
                    </td>
                    <td><StatusBadge status={v.status} /></td>
                    <td className="text-right">
                      <Link href={`/visits/${v.id}`} className="btn-secondary text-xs px-2.5 py-1 whitespace-nowrap">Open Visit</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > PAGE && (
          <div className="px-5 py-2.5 border-t border-slate-100 flex items-center justify-between">
            <p className="text-xs text-slate-400">
              {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
            </p>
            <div className="flex gap-2">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="btn-secondary text-xs px-2 py-1 disabled:opacity-40">Previous</button>
              <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)} className="btn-secondary text-xs px-2 py-1 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
