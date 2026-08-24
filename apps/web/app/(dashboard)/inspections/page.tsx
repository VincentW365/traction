'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';

/**
 * CR-2026-093 — the Inspections hub.
 *
 * One designated area for vehicle condition records: full technical inspections,
 * photo-first pre-inspections, and the job sheet. Open to every internal role;
 * nothing here is required — a visit books, works and closes without any of it,
 * and the wording never implies otherwise.
 */

interface InspectionRow {
  id: string;
  inspectionNumber: string;
  kind: 'VEHICLE_INSPECTION' | 'PRE_INSPECTION';
  status: string;
  createdAt: string;
  customer: { firstName: string; lastName: string } | null;
  vehicle: { plateNumber: string; make: string | null; model: string | null; modelYear: number | null } | null;
  photos?: Array<{ id: string }>;
  recommendations?: Array<{ severity: string }>;
  _count?: { photos: number; recommendations: number };
}

interface BoardItem {
  serviceVisitId: string;
  ticketNumber: string;
  customerName: string;
}
interface QueueBoard {
  waiting?: BoardItem[];
  called?: BoardItem[];
  inService?: BoardItem[];
  [k: string]: unknown;
}

const TABS = [
  { key: 'active', label: 'Active' },
  { key: 'vehicle', label: 'Vehicle Inspections' },
  { key: 'pre', label: 'Pre-Inspections' },
  { key: 'history', label: 'History' },
] as const;

const STATUS_BADGE: Record<string, string> = {
  DRAFT: 'bg-amber-50 text-amber-700',
  COMPLETED: 'bg-emerald-50 text-emerald-700',
  SIGNED_OFF: 'bg-blue-50 text-blue-700',
  CLOSED: 'bg-slate-100 text-slate-600',
  SKIPPED: 'bg-slate-100 text-slate-500',
  CANCELLED: 'bg-slate-100 text-slate-400',
};
const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  COMPLETED: 'Completed',
  SIGNED_OFF: 'Signed off',
  CLOSED: 'Closed',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
};

export default function InspectionsHubPage() {
  const siteId = useSiteId();
  const router = useRouter();

  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('active');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [picker, setPicker] = useState<null | 'VEHICLE_INSPECTION' | 'PRE_INSPECTION' | 'JOB_SHEET'>(null);

  const params = new URLSearchParams();
  if (siteId) params.set('siteId', siteId);
  if (tab === 'vehicle') params.set('kind', 'VEHICLE_INSPECTION');
  if (tab === 'pre') params.set('kind', 'PRE_INSPECTION');
  if (tab === 'active') params.set('active', 'true');
  if (tab === 'history' && !statusFilter) {
    // History means finished business; active drafts stay on the Active tab.
  }
  if (statusFilter) params.set('status', statusFilter);
  if (search.trim()) params.set('q', search.trim());
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  params.set('take', '100');

  const listQuery = useQuery<{ items: InspectionRow[]; total: number }>({
    queryKey: ['inspections', siteId, tab, search, statusFilter, dateFrom, dateTo],
    queryFn: () => api.get(`/inspections?${params.toString()}`),
  });

  const rows = (listQuery.data?.items ?? []).filter((r) => {
    if (tab === 'history') return ['CLOSED', 'SKIPPED', 'CANCELLED', 'COMPLETED', 'SIGNED_OFF'].includes(r.status);
    return true;
  });

  return (
    <div className="page-container">
      <PageHeader
        title="Inspections"
        subtitle="Record optional vehicle condition checks, detailed technical inspections and supporting photographs"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Inspections' }]}
        actions={
          <div className="flex gap-2">
            <button onClick={() => setPicker('JOB_SHEET')} className="btn-secondary text-sm">Job Sheet</button>
            <button onClick={() => setPicker('PRE_INSPECTION')} className="btn-secondary text-sm">New Pre-Inspection</button>
            <button onClick={() => setPicker('VEHICLE_INSPECTION')} className="btn-primary text-sm">New Vehicle Inspection</button>
          </div>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setStatusFilter(''); }}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${
              tab === t.key
                ? 'border-blue-600 text-blue-700 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Customer, registration, inspection or ticket number…"
          className="input-field w-72 text-sm"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input-field w-auto text-sm">
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input-field w-auto text-sm" />
        <span className="text-xs text-slate-400">to</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input-field w-auto text-sm" />
      </div>

      {listQuery.isLoading && <LoadingState message="Loading inspections..." />}
      {listQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Could not load inspections.</p>
        </div>
      )}

      {!listQuery.isLoading && rows.length === 0 && (
        <EmptyState
          title={tab === 'active' ? 'No active inspection records' : 'Nothing here yet'}
          description="Inspections are optional — start one from the buttons above, or from a ticket, visit or customer page."
        />
      )}

      {rows.length > 0 && (
        <div className="card overflow-hidden">
          <div className="table-container">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left">Number</th>
                  <th className="text-left">Type</th>
                  <th className="text-left">Customer / Vehicle</th>
                  <th className="text-left">Status</th>
                  <th className="text-center">Findings</th>
                  <th className="text-center">Photos</th>
                  <th className="text-right">Date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const findings = r._count?.recommendations ?? r.recommendations?.length ?? 0;
                  const photos = r._count?.photos ?? r.photos?.length ?? 0;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => router.push(`/inspections/${r.id}`)}
                      className="cursor-pointer hover:bg-slate-50"
                    >
                      <td className="font-mono text-xs text-blue-700">{r.inspectionNumber}</td>
                      <td>
                        <span className={`badge text-[10px] ${r.kind === 'PRE_INSPECTION' ? 'bg-cyan-50 text-cyan-700' : 'bg-indigo-50 text-indigo-700'}`}>
                          {r.kind === 'PRE_INSPECTION' ? 'Pre-Inspection' : 'Vehicle'}
                        </span>
                      </td>
                      <td>
                        <div className="font-medium text-slate-900">
                          {r.customer ? `${r.customer.firstName} ${r.customer.lastName}` : '—'}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {r.vehicle
                            ? `${r.vehicle.modelYear ?? ''} ${r.vehicle.make ?? ''} ${r.vehicle.model ?? ''}`.trim() +
                              ` · ${r.vehicle.plateNumber}`
                            : ''}
                        </div>
                      </td>
                      <td>
                        <span className={`badge text-[10px] ${STATUS_BADGE[r.status] ?? 'bg-slate-100 text-slate-600'}`}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="text-center text-xs">
                        {findings > 0 ? <span className="text-red-600 font-semibold">{findings}</span> : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="text-center text-xs">
                        {photos > 0 ? photos : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="text-right text-xs text-slate-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {picker && <VisitPicker mode={picker} siteId={siteId} onClose={() => setPicker(null)} />}
    </div>
  );
}

/**
 * Every creation flow starts from a visit: the record inherits customer, vehicle
 * and ticket from it, so nobody retypes what the system already knows.
 */
function VisitPicker({
  mode, siteId, onClose,
}: {
  mode: 'VEHICLE_INSPECTION' | 'PRE_INSPECTION' | 'JOB_SHEET';
  siteId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const board = useQuery<QueueBoard>({
    queryKey: ['queue-board', siteId],
    queryFn: () => api.get(`/queue/board?siteId=${siteId}`),
  });

  const create = useMutation({
    mutationFn: (serviceVisitId: string) =>
      api.post<{ id: string }>('/inspections', { serviceVisitId, kind: mode === 'JOB_SHEET' ? undefined : mode }),
    onSuccess: (r) => {
      onClose();
      router.push(`/inspections/${r.id}`);
    },
  });

  // Today's operational tickets, whatever lane they sit in.
  const items: Array<BoardItem & { lane: string }> = [];
  const b = board.data;
  if (b) {
    for (const [lane, list] of Object.entries(b)) {
      if (!Array.isArray(list)) continue;
      for (const it of list as BoardItem[]) {
        if (it?.serviceVisitId && it?.ticketNumber) items.push({ ...it, lane });
      }
    }
  }

  const title =
    mode === 'VEHICLE_INSPECTION' ? 'New Vehicle Inspection'
    : mode === 'PRE_INSPECTION' ? 'New Pre-Inspection'
    : 'Open Job Sheet';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center">
      <div className="card w-full max-w-md mx-4 max-h-[75vh] flex flex-col">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">{title} — choose the ticket</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
        </div>
        <div className="card-body overflow-y-auto">
          {board.isLoading && <LoadingState message="Loading today's tickets..." />}
          {items.length === 0 && !board.isLoading && (
            <p className="text-xs text-slate-500">
              No tickets on the board right now. Check a vehicle in first, or open the record from the
              visit&apos;s own page.
            </p>
          )}
          <div className="space-y-1">
            {items.map((it) => (
              <button
                key={`${it.serviceVisitId}-${it.lane}`}
                disabled={create.isPending}
                onClick={() => {
                  if (mode === 'JOB_SHEET') {
                    onClose();
                    router.push(`/inspections/job-sheet/${it.serviceVisitId}`);
                  } else {
                    create.mutate(it.serviceVisitId);
                  }
                }}
                className="w-full text-left px-3 py-2 rounded-md border border-slate-200 hover:border-blue-300 hover:bg-blue-50 text-sm flex items-center justify-between gap-3"
              >
                <span className="font-mono text-xs text-slate-700">{it.ticketNumber}</span>
                <span className="flex-grow truncate text-slate-800">{it.customerName}</span>
                <span className="badge bg-slate-100 text-slate-500 text-[10px]">{it.lane}</span>
              </button>
            ))}
          </div>
          {create.isError && (
            <p className="text-xs text-red-600 mt-2">
              {create.error instanceof Error ? create.error.message : 'Could not create the record.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
