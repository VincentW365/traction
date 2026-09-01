'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { StatCard } from '../../../../components/ui/stat-card';
import { LoadingState } from '../../../../components/ui/loading-state';

interface DashboardStats {
  carsToday: number;
  activeTechnicians: number;
  jobsInProgress: number;
  queueDepth: number;
  avgWaitMinutes: number;
  overridesToday: number;
  // CR-2026-098 — counted from the operational states themselves.
  waitingParts: number;
  pausedJobs: number;
  // CR-2026-100 — technician pause requests awaiting acknowledgement.
  pendingPauseApprovals: number;
  // CR-2026-101 — open safety flags / incorrect-data reports.
  attentionItems: number;
}

interface DashboardAlert {
  type: string;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  entityId?: string;
  queueTicketId?: string;
}

// Every alert should take the manager to the screen where it gets corrected:
// job alerts land on the visit workspace (QC approve/rework, unblock, dispatch),
// absences land on the availability planner.
function alertHref(alert: DashboardAlert): string | undefined {
  if (alert.queueTicketId) return `/queue/${alert.queueTicketId}`;
  if (alert.type === 'ABSENT_TECH') return '/admin/availability';
  return undefined;
}

export default function ManagerDashboardPage() {
  const siteId = useSiteId();

  const statsQuery = useQuery<DashboardStats>({
    queryKey: ['manager-dashboard', siteId],
    queryFn: () => api.get(`/manager/dashboard?siteId=${siteId}`),
    refetchInterval: 15000,
  });

  const alertsQuery = useQuery<DashboardAlert[]>({
    queryKey: ['manager-alerts', siteId],
    queryFn: () => api.get(`/manager/alerts?siteId=${siteId}`),
    refetchInterval: 30000,
  });

  const stats = statsQuery.data;
  const alerts = alertsQuery.data ?? [];

  return (
    <div className="page-container">
      <PageHeader
        title="Control Center"
        subtitle="Manager Dashboard"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Control Center' },
        ]}
      />

      {statsQuery.isLoading && <LoadingState message="Loading dashboard..." />}

      {stats && (
        <>
          {/* Row 1: Operations */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <StatCard value={stats.carsToday} label="Cars Today" color="blue" />
            <StatCard value={stats.activeTechnicians} label="Active Techs" color="green" />
            <StatCard value={stats.jobsInProgress} label="Jobs In Progress" color="amber" />
            <StatCard value={stats.queueDepth} label="Queue Depth" color="slate" />
          </div>

          {/* Row 2: Monitoring */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-6">
            <StatCard value={`${stats.avgWaitMinutes}m`} label="Avg Wait" color={stats.avgWaitMinutes > 45 ? 'red' : 'slate'} />
            <StatCard value={stats.overridesToday} label="Overrides Today" color={stats.overridesToday > 0 ? 'amber' : 'slate'} />
            <StatCard value={stats.waitingParts} label="Waiting for Parts" color={stats.waitingParts > 0 ? 'red' : 'slate'} />
            <StatCard value={stats.pausedJobs} label="Paused Jobs" color={stats.pausedJobs > 0 ? 'amber' : 'slate'} />
            {/* CR-2026-100 — someone on the floor reported a stop and is waiting to be heard. */}
            <StatCard value={stats.pendingPauseApprovals ?? 0} label="Pause Approvals" color={(stats.pendingPauseApprovals ?? 0) > 0 ? 'red' : 'slate'} />
            {/* CR-2026-101 — safety flags / incorrect-data reports from the floor. */}
            <StatCard value={stats.attentionItems ?? 0} label="Needs Attention" color={(stats.attentionItems ?? 0) > 0 ? 'red' : 'slate'} />
          </div>
        </>
      )}

      {/* CR-2026-100 — a failed dashboard read must say so, not render blanks. */}
      {statsQuery.isError && (
        <div className="card mb-4 p-4 border-red-200 bg-red-50">
          <p className="text-sm text-red-700">
            Could not load dashboard figures.{' '}
            {statsQuery.error instanceof Error ? statsQuery.error.message : ''}
          </p>
        </div>
      )}
      {alertsQuery.isError && (
        <div className="card mb-4 p-4 border-red-200 bg-red-50">
          <p className="text-sm text-red-700">
            Could not load alerts.{' '}
            {alertsQuery.error instanceof Error ? alertsQuery.error.message : ''}
          </p>
        </div>
      )}

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="card mb-6">
          <div className="card-header">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <h2 className="text-sm font-semibold text-slate-900">
                Active Alerts
                <span className="ml-2 badge bg-red-100 text-red-700">{alerts.length}</span>
              </h2>
            </div>
          </div>
          <div className="divide-y divide-slate-100">
            {alerts.map((alert, i) => {
              const href = alertHref(alert);
              const row = (
                <>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${alert.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900">{alert.title}</p>
                    <p className="text-xs text-slate-500 truncate">{alert.detail}</p>
                  </div>
                  <span className={`badge text-[10px] ${alert.severity === 'critical' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                    {alert.type.replace(/_/g, ' ')}
                  </span>
                  {href && (
                    <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </>
              );
              return href ? (
                <Link key={i} href={href} className="px-5 py-3 flex items-center gap-3 hover:bg-blue-50/40 transition-colors">
                  {row}
                </Link>
              ) : (
                <div key={i} className="px-5 py-3 flex items-center gap-3">
                  {row}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {alerts.length === 0 && alertsQuery.isSuccess && statsQuery.isSuccess && (
        <div className="card mb-6 p-5 flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <p className="text-sm text-slate-600">No active alerts — operations running smoothly.</p>
        </div>
      )}

      {/* Quick Actions */}
      <div className="card">
        <div className="card-header">
          <h2 className="text-sm font-semibold text-slate-900">Quick Actions</h2>
        </div>
        <div className="card-body">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Link href="/admin/staff" className="p-3 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-colors text-center">
              <p className="text-sm font-semibold text-slate-900">Staff</p>
              <p className="text-xs text-slate-500">Manage personnel</p>
            </Link>
            <Link href="/admin/availability" className="p-3 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-colors text-center">
              <p className="text-sm font-semibold text-slate-900">Availability</p>
              <p className="text-xs text-slate-500">Set schedules</p>
            </Link>
            <Link href="/reports" className="p-3 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-colors text-center">
              <p className="text-sm font-semibold text-slate-900">Reports</p>
              <p className="text-xs text-slate-500">KPIs & analytics</p>
            </Link>
            <Link href="/admin/settings" className="p-3 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-colors text-center">
              <p className="text-sm font-semibold text-slate-900">Settings</p>
              <p className="text-xs text-slate-500">Business rules</p>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
