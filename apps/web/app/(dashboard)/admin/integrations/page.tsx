'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';

interface IntegrationRef {
  id: string;
  entityType: string;
  entityId: string;
  system: string;
  externalId: string;
  syncStatus: string;
  lastSyncAt: string | null;
  metadata: any;
}

export default function IntegrationsPage() {
  const siteId = useSiteId();

  // Use existing external refs endpoint to show integration data
  const refsQuery = useQuery<IntegrationRef[]>({
    queryKey: ['integration-refs', siteId],
    queryFn: async () => {
      try {
        return await api.get<IntegrationRef[]>('/integrations/refs?entityType=Site&entityId=' + siteId);
      } catch {
        return [];
      }
    },
  });

  const refs = refsQuery.data ?? [];
  const automateRefs = refs.filter((r) => r.system === 'AUTOMATE');
  const sageRefs = refs.filter((r) => r.system === 'SAGE');

  return (
    <div className="page-container">
      <PageHeader
        title="Integrations"
        subtitle="External system connectivity"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Admin' }, { label: 'Integrations' }]}
      />

      {refsQuery.isLoading && <LoadingState message="Loading integration status..." />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {/* Automate Card */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Automate</h2>
            <span className={`badge text-[10px] ${automateRefs.length > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
              {automateRefs.length > 0 ? 'Connected' : 'No Data'}
            </span>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="input-label">Linked Records</div>
                <p className="text-lg font-bold text-slate-900">{automateRefs.length}</p>
              </div>
              <div>
                <div className="input-label">Last Sync</div>
                <p className="text-sm text-slate-700">
                  {automateRefs.length > 0 && automateRefs[0].lastSyncAt
                    ? new Date(automateRefs[0].lastSyncAt).toLocaleString()
                    : 'Never'}
                </p>
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-3">
              Automate integration provides work order and inventory synchronization.
            </p>
          </div>
        </div>

        {/* Sage Card */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Sage</h2>
            <span className={`badge text-[10px] ${sageRefs.length > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
              {sageRefs.length > 0 ? 'Connected' : 'No Data'}
            </span>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="input-label">Linked Records</div>
                <p className="text-lg font-bold text-slate-900">{sageRefs.length}</p>
              </div>
              <div>
                <div className="input-label">Last Sync</div>
                <p className="text-sm text-slate-700">
                  {sageRefs.length > 0 && sageRefs[0].lastSyncAt
                    ? new Date(sageRefs[0].lastSyncAt).toLocaleString()
                    : 'Never'}
                </p>
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-3">
              Sage integration provides labor costing and accounting synchronization.
            </p>
          </div>
        </div>
      </div>

      <div className="card p-5 text-center">
        <p className="text-sm text-slate-500">
          Integration providers are currently in stub mode. Configure real providers in Settings.
        </p>
      </div>
    </div>
  );
}
