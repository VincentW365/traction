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

interface InspectionRow {
  id: string;
  inspectionNumber: string;
  status: string;
  createdAt: string;
  signedOffAt: string | null;
  customer: { id: string; firstName: string; lastName: string } | null;
  vehicle: { id: string; plateNumber: string } | null;
}
interface InspectionList { items: InspectionRow[]; total: number; take: number; skip: number }

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function InspectionsPage() {
  const siteId = useSiteId();
  const [status, setStatus] = useState('');

  const q = useQuery<InspectionList>({
    queryKey: ['inspections', siteId, status],
    queryFn: () => {
      const p = new URLSearchParams({ siteId });
      if (status) p.set('status', status);
      return api.get<InspectionList>(`/inspections?${p.toString()}`);
    },
    enabled: !!siteId,
  });

  const items = q.data?.items ?? [];

  return (
    <div className="page-container">
      <PageHeader
        title="Inspections"
        subtitle="Visual inspection forms"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Inspections' }]}
        actions={
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="input-field w-auto text-sm">
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="COMPLETED">Completed</option>
            <option value="SIGNED_OFF">Signed off</option>
            <option value="CLOSED">Closed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        }
      />

      {q.isLoading && <LoadingState message="Loading inspections..." />}
      {q.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load inspections.</p>
        </div>
      )}
      {q.data && items.length === 0 && (
        <EmptyState title="No inspections" description="Start a visual inspection from a queue ticket." />
      )}

      {items.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr><th>Inspection #</th><th>Customer</th><th>Vehicle</th><th>Status</th><th className="text-right">Created</th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="table-row">
                  <td><Link href={`/inspections/${i.id}`} className="font-mono text-xs font-semibold text-blue-600 hover:underline">{i.inspectionNumber}</Link></td>
                  <td className="text-slate-700">{i.customer ? `${i.customer.firstName} ${i.customer.lastName}` : '—'}</td>
                  <td className="text-slate-600 font-mono text-xs">{i.vehicle?.plateNumber ?? '—'}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td className="text-right text-slate-500 whitespace-nowrap">{fmtDate(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
