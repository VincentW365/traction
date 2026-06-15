'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { StatCard } from '../../../../components/ui/stat-card';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument, ExportSection } from '../../../../lib/export';
import { serviceClassLabel, type VehicleServiceClass, type ClassificationConfidence } from '../../../../lib/vehicle-classes';

const ALLOWED_ROLES = ['ADMIN', 'MANAGER'];

interface ClassificationStats {
  totalLive: number;
  classified: number;
  unclassified: number;
  percentClassified: number;
  mobileJackEligible: number;
  confirmedByClass: { serviceClass: VehicleServiceClass; count: number }[];
  pendingByConfidence: { confidence: ClassificationConfidence; count: number }[];
}

interface ClassificationProductivity {
  days: number;
  dailyTarget: number;
  today: { confirmed: number; target: number; remainingToTarget: number };
  remainingUnclassified: number;
  recentAvgPerDay: number;
  projectionDaysAtRecent: number | null;
  projectionDaysAtTarget: number | null;
  velocity: { date: string; confirmed: number }[];
  byReviewer: { reviewerId: string; reviewerName: string; confirmed: number }[];
}

export default function ClassificationProgressPage() {
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');

  const statsQuery = useQuery({
    queryKey: ['classification-stats'],
    queryFn: () => api.get<ClassificationStats>('/vehicles/classification/stats'),
    enabled: allowed,
  });

  const prodQuery = useQuery({
    queryKey: ['classification-productivity', 14],
    queryFn: () => api.get<ClassificationProductivity>('/vehicles/classification/productivity?days=14'),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Classification Progress" subtitle="Manager report" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">You do not have permission to view this report.</p>
        </div>
      </div>
    );
  }

  const s = statsQuery.data;

  const buildExport = (): ExportDocument | null => {
    if (!s) return null;
    const p = prodQuery.data;
    const sections: ExportSection[] = [
      {
        heading: 'Summary',
        columns: ['Metric', 'Value'],
        rows: [
          ['Live vehicles', s.totalLive],
          ['Classified', s.classified],
          ['Classified %', `${s.percentClassified}%`],
          ['Remaining unclassified', s.unclassified],
          ['Mobile-jack eligible (sedan)', s.mobileJackEligible],
        ],
      },
      {
        heading: 'Confirmed by service class',
        columns: ['Service class', 'Vehicles'],
        rows: s.confirmedByClass.map((c) => [serviceClassLabel(c.serviceClass), c.count]),
      },
      {
        heading: 'Remaining unclassified, by suggestion confidence',
        columns: ['Confidence', 'Vehicles'],
        rows: s.pendingByConfidence.map((p2) => [p2.confidence, p2.count]),
      },
    ];
    if (p) {
      sections.push(
        {
          heading: `Productivity (last ${p.days} days)`,
          columns: ['Metric', 'Value'],
          rows: [
            ['Confirmed today vs target', `${p.today.confirmed} / ${p.today.target}`],
            ['Avg confirmed / active day', p.recentAvgPerDay],
            ['Days to clear (recent pace)', p.projectionDaysAtRecent ?? '—'],
            ['Days to clear (target pace)', p.projectionDaysAtTarget ?? '—'],
            ['Remaining unclassified', p.remainingUnclassified],
          ],
        },
        {
          heading: 'Confirmation velocity',
          columns: ['Date', 'Confirmed'],
          rows: p.velocity.map((v) => [v.date, v.confirmed]),
        },
        {
          heading: 'Confirmations by reviewer',
          columns: ['Reviewer', 'Confirmed'],
          rows: p.byReviewer.map((r) => [r.reviewerName, r.confirmed]),
        },
      );
    }
    return {
      title: 'Classification Progress',
      filename: 'classification-progress',
      subtitle: 'Vehicle service-class classification burn-down (live vehicles only)',
      sections,
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Classification Progress"
        subtitle="Vehicle service-class classification burn-down (live vehicles only)"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Reports', href: '/reports' },
          { label: 'Classification Progress' },
        ]}
        actions={<ExportMenu build={buildExport} disabled={!s} />}
      />

      {statsQuery.isLoading && <LoadingState message="Loading classification progress..." />}

      {statsQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load this report.</p>
        </div>
      )}

      {s && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard value={s.totalLive} label="Live vehicles" color="slate" />
            <StatCard
              value={s.classified}
              label="Classified"
              color="green"
              icon={<span className="text-xs font-medium text-slate-400">{s.percentClassified}%</span>}
            />
            <StatCard value={s.unclassified} label="Remaining unclassified" color="amber" />
            <StatCard value={s.mobileJackEligible} label="Mobile-jack eligible (sedan)" color="blue" />
          </div>

          {s.totalLive === 0 && (
            <div className="mt-6">
              <EmptyState title="No live vehicles" description="There are no operational vehicles to classify." />
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            {/* Confirmed by service class */}
            <div className="card">
              <div className="card-header">
                <h2 className="text-sm font-semibold text-slate-900">Confirmed by service class</h2>
              </div>
              <div className="table-container">
                <table className="w-full text-sm">
                  <thead className="table-header">
                    <tr>
                      <th>Service class</th>
                      <th className="text-right">Vehicles</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.confirmedByClass.map((c) => (
                      <tr
                        key={c.serviceClass}
                        className={`table-row ${c.serviceClass === 'SEDAN_CLASS' ? 'bg-blue-50/40' : ''}`}
                      >
                        <td>
                          {serviceClassLabel(c.serviceClass)}
                          {c.serviceClass === 'SEDAN_CLASS' && (
                            <span className="ml-2 badge bg-blue-100 text-blue-700 border border-blue-200">
                              jack-eligible
                            </span>
                          )}
                        </td>
                        <td className="text-right font-medium text-slate-900">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Remaining by confidence */}
            <div className="card">
              <div className="card-header">
                <h2 className="text-sm font-semibold text-slate-900">Remaining unclassified, by suggestion confidence</h2>
              </div>
              <div className="table-container">
                <table className="w-full text-sm">
                  <thead className="table-header">
                    <tr>
                      <th>Confidence</th>
                      <th className="text-right">Vehicles</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.pendingByConfidence.map((p) => (
                      <tr key={p.confidence} className="table-row">
                        <td>{p.confidence}</td>
                        <td className="text-right font-medium text-slate-900">{p.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      {prodQuery.data && (
        <div className="mt-8">
          <h2 className="text-base font-semibold text-slate-900 mb-3">
            Productivity <span className="text-sm font-normal text-slate-400">(last {prodQuery.data.days} days)</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              value={`${prodQuery.data.today.confirmed} / ${prodQuery.data.today.target}`}
              label="Confirmed today vs target"
              color={prodQuery.data.today.remainingToTarget === 0 ? 'green' : 'amber'}
              icon={<span className="text-xs font-medium text-slate-400">{prodQuery.data.today.remainingToTarget} to go</span>}
            />
            <StatCard value={prodQuery.data.recentAvgPerDay} label="Avg confirmed / active day" color="blue" />
            <StatCard value={prodQuery.data.projectionDaysAtRecent ?? '—'} label="Days to clear (recent pace)" color="slate" />
            <StatCard value={prodQuery.data.remainingUnclassified} label="Remaining unclassified" color="amber" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
            {/* Confirmation velocity */}
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">Confirmation velocity</h3>
              </div>
              <div className="card-body">
                {prodQuery.data.velocity.length === 0 ? (
                  <p className="text-sm text-slate-500">No confirmations in this window yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {(() => {
                      const max = Math.max(...prodQuery.data.velocity.map((v) => v.confirmed), 1);
                      return prodQuery.data.velocity.map((v) => (
                        <div key={v.date} className="flex items-center gap-2 text-xs">
                          <span className="w-20 shrink-0 font-mono text-slate-500">{v.date}</span>
                          <div className="flex-1 bg-slate-100 rounded h-3">
                            <div className="bg-blue-500 h-3 rounded" style={{ width: `${(v.confirmed / max) * 100}%` }} />
                          </div>
                          <span className="w-8 shrink-0 text-right font-medium text-slate-700">{v.confirmed}</span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            </div>

            {/* Confirmations by reviewer */}
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">Confirmations by reviewer</h3>
              </div>
              <div className="table-container">
                <table className="w-full text-sm">
                  <thead className="table-header">
                    <tr>
                      <th>Reviewer</th>
                      <th className="text-right">Confirmed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prodQuery.data.byReviewer.length === 0 ? (
                      <tr><td colSpan={2} className="text-sm text-slate-500 px-4 py-3">No confirmations in this window yet.</td></tr>
                    ) : (
                      prodQuery.data.byReviewer.map((r) => (
                        <tr key={r.reviewerId} className="table-row">
                          <td className="text-slate-700">{r.reviewerName}</td>
                          <td className="text-right font-medium text-slate-900">{r.confirmed}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
