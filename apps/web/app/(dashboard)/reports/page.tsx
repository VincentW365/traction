'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { useAuth } from '../../../hooks/use-auth';
import { PageHeader } from '../../../components/ui/page-header';
import { StatCard } from '../../../components/ui/stat-card';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';

const ALLOWED_ROLES = ['ADMIN', 'MANAGER'];

interface KpiMetric {
  code: string;
  name: string;
  value: number | string | null;
  target: string | null;
}

function kpiColor(code: string): 'blue' | 'green' | 'amber' | 'red' | 'slate' {
  const c = code.toLowerCase();
  if (c.includes('completed') || c.includes('on_time') || c.includes('success')) return 'green';
  if (c.includes('blocked') || c.includes('missed') || c.includes('error') || c.includes('overdue')) return 'red';
  if (c.includes('wait') || c.includes('late') || c.includes('pending') || c.includes('avg')) return 'amber';
  return 'blue';
}

export default function ReportsPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const today = new Date().toISOString().split('T')[0];
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);

  const kpiQuery = useQuery({
    queryKey: ['kpis', siteId, startDate, endDate],
    queryFn: () =>
      api.get<KpiMetric[]>(
        `/reports/kpis?siteId=${siteId}&startDate=${startDate}&endDate=${endDate}`,
      ),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Reports" subtitle="Key performance indicators" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">You do not have permission to view this report.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Reports"
        subtitle="Key performance indicators"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Reports' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="input-field w-auto"
            />
            <span className="text-sm text-slate-400">to</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="input-field w-auto"
            />
          </div>
        }
      />

      {kpiQuery.isLoading && (
        <LoadingState message="Loading KPIs..." />
      )}

      {kpiQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load this report.</p>
        </div>
      )}

      {kpiQuery.data && kpiQuery.data.length === 0 && (
        <EmptyState
          title="No KPI data available"
          description="Try selecting a different date range."
        />
      )}

      {kpiQuery.data && kpiQuery.data.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {kpiQuery.data.map((kpi) => (
            <StatCard
              key={kpi.code}
              value={kpi.value !== null ? String(kpi.value) : '--'}
              label={kpi.name}
              color={kpiColor(kpi.code)}
              icon={
                kpi.target ? (
                  <span className="text-xs font-medium text-slate-400">
                    Target: {kpi.target}
                  </span>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
