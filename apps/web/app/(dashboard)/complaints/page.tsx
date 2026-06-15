'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { useAuth } from '../../../hooks/use-auth';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';
import { StatusBadge } from '../../../components/status-badge';
import { ExportMenu } from '../../../components/ui/export-menu';
import type { ExportDocument } from '../../../lib/export';

interface ComplaintRow {
  id: string;
  complaintNumber: string;
  subject: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  slaDueAt: string | null;
  createdAt: string;
  customer: { id: string; firstName: string; lastName: string } | null;
}
interface ComplaintList { items: ComplaintRow[]; total: number; take: number; skip: number }

const SEVERITY_CLASS: Record<string, string> = {
  LOW: 'bg-slate-100 text-slate-600',
  MEDIUM: 'bg-blue-50 text-blue-700',
  HIGH: 'bg-amber-50 text-amber-700',
  CRITICAL: 'bg-red-50 text-red-700',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function isOverdue(c: ComplaintRow): boolean {
  return c.status !== 'RESOLVED' && c.slaDueAt != null && new Date(c.slaDueAt).getTime() < Date.now();
}

export default function ComplaintsPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const canCreate = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'SERVICE_ADVISOR'].includes(user?.roleCode ?? '');
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');

  const query = useQuery<ComplaintList>({
    queryKey: ['complaints', siteId, status, severity, type],
    queryFn: () => {
      const params = new URLSearchParams({ siteId });
      if (status) params.set('status', status);
      if (severity) params.set('severity', severity);
      if (type) params.set('type', type);
      return api.get<ComplaintList>(`/complaints?${params.toString()}`);
    },
    enabled: !!siteId,
  });

  const items = query.data?.items ?? [];

  const buildExport = (): ExportDocument | null => {
    if (!query.data) return null;
    return {
      title: 'Complaints',
      filename: 'complaints',
      subtitle: 'Customer complaints log & triage',
      meta: [
        ['Filters', [status && `Status: ${status}`, severity && `Severity: ${severity}`, type && `Type: ${type}`].filter(Boolean).join(' · ') || 'None'],
        ['Complaints', String(items.length)],
      ],
      sections: [
        {
          columns: ['Complaint #', 'Customer', 'Subject', 'Type', 'Severity', 'Status', 'SLA due', 'Overdue', 'Opened'],
          rows: items.map((c) => [
            c.complaintNumber,
            c.customer ? `${c.customer.firstName} ${c.customer.lastName}` : '',
            c.subject,
            c.type.replace(/_/g, ' '),
            c.severity,
            c.status,
            c.status === 'RESOLVED' ? '' : fmtDate(c.slaDueAt),
            isOverdue(c) ? 'YES' : '',
            fmtDate(c.createdAt),
          ]),
        },
      ],
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Complaints"
        subtitle="Customer complaints log & triage"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Complaints' }]}
        actions={
          <div className="flex items-center gap-2">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input-field w-auto text-sm">
              <option value="">All statuses</option>
              <option value="OPEN">Open</option>
              <option value="ACKNOWLEDGED">Acknowledged</option>
              <option value="RESOLVED">Resolved</option>
            </select>
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="input-field w-auto text-sm">
              <option value="">All severities</option>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="CRITICAL">Critical</option>
            </select>
            <ExportMenu build={buildExport} disabled={!query.data} />
            {canCreate && <Link href="/complaints/new" className="btn-primary text-sm whitespace-nowrap">Log Complaint</Link>}
          </div>
        }
      />

      {query.isLoading && <LoadingState message="Loading complaints..." />}
      {query.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load complaints.</p>
        </div>
      )}
      {query.data && items.length === 0 && (
        <EmptyState title="No complaints" description="No complaints match the current filters." />
      )}

      {items.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Complaint #</th>
                <th>Customer</th>
                <th>Subject</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Status</th>
                <th>SLA</th>
                <th className="text-right">Opened</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="table-row">
                  <td>
                    <Link href={`/complaints/${c.id}`} className="font-mono text-xs font-semibold text-blue-600 hover:underline">{c.complaintNumber}</Link>
                  </td>
                  <td className="text-slate-700">{c.customer ? `${c.customer.firstName} ${c.customer.lastName}` : '—'}</td>
                  <td className="text-slate-600 max-w-[260px] truncate" title={c.subject}>{c.subject}</td>
                  <td className="text-xs text-slate-500">{c.type.replace(/_/g, ' ')}</td>
                  <td><span className={`badge ${SEVERITY_CLASS[c.severity] ?? 'bg-slate-100 text-slate-600'}`}>{c.severity}</span></td>
                  <td><StatusBadge status={c.status} /></td>
                  <td>
                    {isOverdue(c)
                      ? <span className="badge bg-red-50 text-red-700">Overdue</span>
                      : <span className="text-xs text-slate-400">{c.status === 'RESOLVED' ? '—' : fmtDate(c.slaDueAt)}</span>}
                  </td>
                  <td className="text-right text-slate-500 whitespace-nowrap">{fmtDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
