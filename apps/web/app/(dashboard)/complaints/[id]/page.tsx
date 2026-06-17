'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../components/status-badge';

interface TimelineRow {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedAt: string;
  notes: string | null;
  changedBy: { fullName: string; roleCode: string } | null;
}
interface ComplaintDetail {
  id: string;
  complaintNumber: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  subject: string;
  description: string;
  slaDueAt: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  customer: { id: string; firstName: string; lastName: string; phone: string | null } | null;
  serviceVisit: { id: string; status: string } | null;
  serviceOrder: { id: string; status: string } | null;
  timeline: TimelineRow[];
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function ComplaintDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const qc = useQueryClient();
  const { user } = useAuth();
  const isManager = ['ADMIN'].includes(user?.roleCode ?? '');

  const [resolutionNotes, setResolutionNotes] = useState('');

  const { data: c, isLoading, error } = useQuery<ComplaintDetail>({
    queryKey: ['complaint', id],
    queryFn: () => api.get(`/complaints/${id}`),
    enabled: !!id,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['complaint', id] });
  const ackMutation = useMutation({ mutationFn: () => api.post(`/complaints/${id}/acknowledge`, {}), onSuccess: invalidate });
  const resolveMutation = useMutation({
    mutationFn: () => api.post(`/complaints/${id}/resolve`, { resolutionNotes: resolutionNotes.trim() }),
    onSuccess: () => { setResolutionNotes(''); invalidate(); },
  });

  if (isLoading) return <div className="page-container"><LoadingState message="Loading complaint..." /></div>;
  if (error || !c) {
    return (
      <div className="page-container">
        <PageHeader title="Complaint" breadcrumbs={[{ label: 'Complaints', href: '/complaints' }, { label: 'Error' }]} />
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">{(error as Error)?.message ?? 'Complaint not found.'}</p>
        </div>
      </div>
    );
  }

  const overdue = c.status !== 'RESOLVED' && c.slaDueAt != null && new Date(c.slaDueAt).getTime() < Date.now();

  return (
    <div className="page-container">
      <PageHeader
        title={c.complaintNumber}
        breadcrumbs={[{ label: 'Complaints', href: '/complaints' }, { label: c.complaintNumber }]}
        actions={<StatusBadge status={c.status} />}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main */}
        <div className="lg:col-span-2 space-y-6">
          <div className="card">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">{c.subject}</h2></div>
            <div className="card-body space-y-3">
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{c.description}</p>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-500 pt-2 border-t border-slate-100">
                <span>Type: <span className="text-slate-700">{c.type.replace(/_/g, ' ')}</span></span>
                <span>Severity: <span className="text-slate-700">{c.severity}</span></span>
                <span>SLA due: <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-700'}>{fmtDateTime(c.slaDueAt)}{overdue ? ' (overdue)' : ''}</span></span>
                <span>Opened: <span className="text-slate-700">{fmtDateTime(c.createdAt)}</span></span>
              </div>
              {c.customer && (
                <div className="text-xs text-slate-500">
                  Customer: <Link href={`/customers/${c.customer.id}`} className="text-blue-600 hover:underline">{c.customer.firstName} {c.customer.lastName}</Link>
                  {c.customer.phone && <span className="ml-2 font-mono">{c.customer.phone}</span>}
                </div>
              )}
              {(c.serviceVisit || c.serviceOrder) && (
                <div className="text-xs text-slate-500 flex gap-4">
                  {c.serviceVisit && <span>Linked visit: {c.serviceVisit.status}</span>}
                  {c.serviceOrder && <span>Linked order: <Link href={`/queue/${c.serviceOrder.id}`} className="text-blue-600 hover:underline">{c.serviceOrder.status}</Link></span>}
                </div>
              )}
            </div>
          </div>

          {/* Resolution */}
          {c.status === 'RESOLVED' ? (
            <div className="card border-l-4 border-l-emerald-400">
              <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Resolution</h2></div>
              <div className="card-body">
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{c.resolutionNotes}</p>
                <p className="text-xs text-slate-400 mt-2">Resolved {fmtDateTime(c.resolvedAt)}</p>
              </div>
            </div>
          ) : isManager ? (
            <div className="card">
              <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Manager actions</h2></div>
              <div className="card-body space-y-3">
                {c.status === 'OPEN' && (
                  <button onClick={() => ackMutation.mutate()} disabled={ackMutation.isPending} className="btn-secondary text-sm">
                    {ackMutation.isPending ? 'Acknowledging...' : 'Acknowledge'}
                  </button>
                )}
                <div>
                  <label className="input-label">Resolution notes (required to resolve)</label>
                  <textarea value={resolutionNotes} onChange={(e) => setResolutionNotes(e.target.value)} rows={3} className="input-field" placeholder="How was it resolved?" />
                </div>
                {resolveMutation.isError && (
                  <p className="text-xs text-red-600">{resolveMutation.error instanceof Error ? resolveMutation.error.message : 'Failed to resolve'}</p>
                )}
                <button onClick={() => resolveMutation.mutate()} disabled={!resolutionNotes.trim() || resolveMutation.isPending} className="btn-primary text-sm disabled:opacity-50">
                  {resolveMutation.isPending ? 'Resolving...' : 'Resolve complaint'}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Timeline */}
        <div className="card h-fit">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">History</h2></div>
          <div className="card-body">
            <ol className="space-y-3">
              {c.timeline.map((t) => (
                <li key={t.id} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                    <span className="font-medium text-slate-700">{t.fromStatus ? `${t.fromStatus} → ${t.toStatus}` : t.toStatus}</span>
                  </div>
                  <div className="ml-3.5 text-slate-400">
                    {fmtDateTime(t.changedAt)}{t.changedBy ? ` · ${t.changedBy.fullName}` : ''}
                  </div>
                  {t.notes && <div className="ml-3.5 text-slate-500 mt-0.5">{t.notes}</div>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
