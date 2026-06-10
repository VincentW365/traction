'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { StatCard } from '../../../../components/ui/stat-card';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
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

export default function ClassificationProgressPage() {
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');

  const statsQuery = useQuery({
    queryKey: ['classification-stats'],
    queryFn: () => api.get<ClassificationStats>('/vehicles/classification/stats'),
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
      />

      {statsQuery.isLoading && <LoadingState message="Loading classification progress..." />}

      {statsQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load classification progress.</p>
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
    </div>
  );
}
