'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { StatCard } from '../../../../components/ui/stat-card';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';

const ALLOWED_ROLES = ['ADMIN', 'MANAGER'];

interface ReworkItem {
  id: string;
  serviceOrderId: string;
  reasonCode: string;
  description: string | null;
  reworkCount: number;
  openedAt: string;
  closedAt: string | null;
  customerName: string;
  vehiclePlate: string;
  primaryTechnician: string | null;
}
interface ReworkReport {
  summary: { totalOrders: number; reworkedOrders: number; reworkRate: number; firstTimeFixRate: number };
  items: ReworkItem[];
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function ReworkReportPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const reworkQuery = useQuery<ReworkReport>({
    queryKey: ['rework-report', siteId, from, to],
    queryFn: () => {
      const params = new URLSearchParams({ siteId });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return api.get<ReworkReport>(`/reports/rework?${params.toString()}`);
    },
    enabled: allowed && !!siteId,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Rework / First-Time-Fix" subtitle="Jobs that came back for re-service" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">You do not have permission to view this report.</p>
        </div>
      </div>
    );
  }

  const data = reworkQuery.data;

  return (
    <div className="page-container">
      <PageHeader
        title="Rework / First-Time-Fix"
        subtitle="Jobs that came back because the work wasn't right the first time"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Reports', href: '/reports' },
          { label: 'Rework / FTF' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field w-auto" />
            <span className="text-sm text-slate-400">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field w-auto" />
          </div>
        }
      />

      {reworkQuery.isLoading && <LoadingState message="Loading rework report..." />}

      {reworkQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load this report.</p>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <StatCard value={`${data.summary.firstTimeFixRate}%`} label="First-Time-Fix Rate" color="green" />
            <StatCard value={`${data.summary.reworkRate}%`} label="Rework Rate" color="red" />
            <StatCard value={data.summary.reworkedOrders} label="Reworked Orders" color="amber" />
            <StatCard value={data.summary.totalOrders} label="Total Orders" color="blue" />
          </div>

          {data.items.length === 0 ? (
            <EmptyState
              title="No rework on record"
              description="No jobs came back for re-service in the selected range."
            />
          ) : (
            <div className="table-container">
              <table className="w-full text-sm">
                <thead className="table-header">
                  <tr>
                    <th>Opened</th>
                    <th>Customer</th>
                    <th>Vehicle</th>
                    <th>Reason</th>
                    <th className="text-center">Times back</th>
                    <th>Primary tech</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id} className="table-row">
                      <td className="text-slate-700 whitespace-nowrap">{fmtDate(r.openedAt)}</td>
                      <td className="text-slate-600">{r.customerName || '—'}</td>
                      <td className="text-slate-600 font-mono text-xs">{r.vehiclePlate || '—'}</td>
                      <td className="text-slate-600">
                        <span className="font-medium">{r.reasonCode}</span>
                        {r.description && <span className="block text-xs text-slate-400 truncate max-w-[260px]" title={r.description}>{r.description}</span>}
                      </td>
                      <td className="text-center tabular-nums font-semibold text-red-600">{r.reworkCount}</td>
                      <td className="text-slate-600">{r.primaryTechnician ?? '—'}</td>
                      <td>
                        {r.closedAt
                          ? <span className="badge bg-emerald-50 text-emerald-700">Closed {fmtDate(r.closedAt)}</span>
                          : <span className="badge bg-amber-50 text-amber-700">Open</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
