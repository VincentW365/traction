'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { PageHeader } from '../../../components/ui/page-header';
import { StatCard } from '../../../components/ui/stat-card';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';

interface KpiMetric {
  code: string;
  name: string;
  value: number | string | null;
  target: string | null;
}

export default function ReportsPage() {
  const siteId = useSiteId();
  const today = new Date().toISOString().split('T')[0];
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);

  const kpiQuery = useQuery({
    queryKey: ['kpis', siteId, startDate, endDate],
    queryFn: () =>
      api.get<KpiMetric[]>(
        `/reports/kpis?siteId=${siteId}&startDate=${startDate}&endDate=${endDate}`,
      ),
  });

  const is403 = kpiQuery.isError &&
    kpiQuery.error instanceof Error &&
    kpiQuery.error.message.includes('403');

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
        is403 ? (
          <div className="card p-8 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v.01M12 9v3m0-3a9 9 0 110 18 9 9 0 010-18z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-slate-700">Permission Denied</h3>
            <p className="text-xs text-slate-400 mt-1">You do not have permission to view reports. Please sign in as a Manager.</p>
          </div>
        ) : (
          <div className="card p-6 text-center border-red-200 bg-red-50">
            <p className="text-sm text-red-700">Failed to load reports.</p>
          </div>
        )
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
              color="blue"
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
