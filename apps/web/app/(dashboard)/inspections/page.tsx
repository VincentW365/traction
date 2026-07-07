'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';
import { StatusBadge } from '../../../components/status-badge';
import { ExportMenu } from '../../../components/ui/export-menu';
import type { ExportDocument } from '../../../lib/export';

interface Findings { immediate: number; future: number; total: number }
interface InspectionRow {
  id: string;
  inspectionNumber: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  signedOffAt: string | null;
  closedAt: string | null;
  inspectionDate: string;
  findings: Findings;
  customer: { id: string; firstName: string; lastName: string } | null;
  vehicle: { id: string; plateNumber: string; make: string | null; model: string | null } | null;
}
interface InspectionList { items: InspectionRow[]; total: number; take: number; skip: number }

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Local calendar day as YYYY-MM-DD (what the user expects a preset to mean). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function FindingsCell({ f }: { f: Findings }) {
  if (f.total === 0) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {f.immediate > 0 && <span className="badge bg-red-50 text-red-700">{f.immediate} immediate</span>}
      {f.future > 0 && <span className="badge bg-amber-50 text-amber-700">{f.future} future</span>}
    </span>
  );
}

type Tab = 'active' | 'history';

export default function InspectionsPage() {
  const siteId = useSiteId();
  const [tab, setTab] = useState<Tab>('active');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const query = useQuery<InspectionList>({
    queryKey: ['inspections', siteId, tab, q, status, dateFrom, dateTo],
    queryFn: () => {
      const p = new URLSearchParams({ siteId });
      if (q.trim()) p.set('q', q.trim());
      if (tab === 'active') {
        p.set('active', 'true');
      } else {
        if (status) p.set('status', status);
        if (dateFrom) p.set('dateFrom', dateFrom);
        if (dateTo) p.set('dateTo', dateTo);
      }
      return api.get<InspectionList>(`/inspections?${p.toString()}`);
    },
    enabled: !!siteId,
  });

  const items = query.data?.items ?? [];

  const setPreset = (preset: 'today' | 'yesterday' | 'week') => {
    const now = new Date();
    if (preset === 'today') {
      setDateFrom(ymd(now));
      setDateTo(ymd(now));
    } else if (preset === 'yesterday') {
      const y = new Date(now);
      y.setDate(now.getDate() - 1);
      setDateFrom(ymd(y));
      setDateTo(ymd(y));
    } else {
      // This week — Monday through today.
      const start = new Date(now);
      const dow = (now.getDay() + 6) % 7; // 0 = Monday
      start.setDate(now.getDate() - dow);
      setDateFrom(ymd(start));
      setDateTo(ymd(now));
    }
  };

  const clearDates = () => { setDateFrom(''); setDateTo(''); setStatus(''); };

  const buildExport = (): ExportDocument | null => {
    if (!query.data) return null;
    return {
      title: 'Inspections',
      filename: tab === 'active' ? 'inspections-active' : 'inspections-history',
      subtitle: tab === 'active' ? 'Active inspections (needs action)' : 'Inspection history',
      meta: [
        ['View', tab === 'active' ? 'Active' : 'History'],
        ...(tab === 'history' && (dateFrom || dateTo) ? [['Dates', `${dateFrom || '…'} → ${dateTo || '…'}`] as [string, string]] : []),
        ['Inspections', String(items.length)],
      ],
      sections: [
        {
          columns: ['Inspection #', 'Customer', 'Vehicle', 'Status', 'Date', 'Immediate', 'Future'],
          rows: items.map((i) => [
            i.inspectionNumber,
            i.customer ? `${i.customer.firstName} ${i.customer.lastName}` : '',
            i.vehicle?.plateNumber ?? '',
            i.status,
            fmtDate(i.inspectionDate),
            String(i.findings.immediate),
            String(i.findings.future),
          ]),
        },
      ],
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Inspections"
        subtitle="Visual inspection forms"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Inspections' }]}
        actions={<ExportMenu build={buildExport} disabled={!query.data} />}
      />

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 mb-4">
        {(['active', 'history'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t === 'active' ? 'Active' : 'History'}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search inspection #, customer, plate…"
          className="input-field text-sm max-w-xs"
        />
        {tab === 'history' && (
          <>
            <div className="flex items-center gap-1">
              <button onClick={() => setPreset('today')} className="btn-secondary text-xs px-2.5 py-1.5">Today</button>
              <button onClick={() => setPreset('yesterday')} className="btn-secondary text-xs px-2.5 py-1.5">Yesterday</button>
              <button onClick={() => setPreset('week')} className="btn-secondary text-xs px-2.5 py-1.5">This week</button>
            </div>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input-field text-sm w-auto" />
            <span className="text-slate-400 text-sm">→</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input-field text-sm w-auto" />
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input-field w-auto text-sm">
              <option value="">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="COMPLETED">Completed</option>
              <option value="SIGNED_OFF">Signed off</option>
              <option value="CLOSED">Closed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
            {(dateFrom || dateTo || status) && (
              <button onClick={clearDates} className="text-xs text-slate-400 hover:text-slate-600">Clear</button>
            )}
          </>
        )}
      </div>

      {tab === 'active' && (
        <p className="text-xs text-slate-400 mb-3">
          Showing inspections that still need action (draft, completed, awaiting customer sign-off). Closed and
          cancelled inspections move to <button onClick={() => setTab('history')} className="text-blue-600 hover:underline">History</button>.
        </p>
      )}

      {query.isLoading && <LoadingState message="Loading inspections..." />}
      {query.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load inspections.</p>
        </div>
      )}
      {query.data && items.length === 0 && (
        <EmptyState
          title={tab === 'active' ? 'No active inspections' : 'No inspections found'}
          description={tab === 'active' ? 'Start a visual inspection from a queue ticket.' : 'Try a wider date range or clear the filters.'}
        />
      )}

      {items.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Inspection #</th>
                <th>Customer</th>
                <th>Vehicle</th>
                <th>Status</th>
                <th>Findings</th>
                <th className="text-right">Date</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="table-row">
                  <td>
                    <Link href={`/inspections/${i.id}`} className="font-mono text-xs font-semibold text-blue-600 hover:underline">
                      {i.inspectionNumber}
                    </Link>
                  </td>
                  <td className="text-slate-700">{i.customer ? `${i.customer.firstName} ${i.customer.lastName}` : '—'}</td>
                  <td className="text-slate-600 font-mono text-xs">{i.vehicle?.plateNumber ?? '—'}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td><FindingsCell f={i.findings} /></td>
                  <td className="text-right text-slate-500 whitespace-nowrap">{fmtDate(i.inspectionDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
