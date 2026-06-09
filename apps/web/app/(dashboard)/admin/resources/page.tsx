'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { StatusBadge } from '../../../../components/status-badge';

interface WorkResource {
  id: string;
  code: string;
  name: string;
  resourceCategory: string;
  maxVehicleWeight: string | null;
  liftType: string | null;
  hasAlignment: boolean;
  hasDiagnostics: boolean;
  requiresMechanic: boolean;
  isActive: boolean;
  displayOrder: number;
}

export default function ResourcesAdminPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [categoryFilter, setCategoryFilter] = useState('');

  const resQuery = useQuery<WorkResource[]>({
    queryKey: ['resources-admin', siteId],
    queryFn: () => api.get(`/resources?siteId=${siteId}`),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/resources/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['resources-admin'] }),
  });

  const data = resQuery.data ?? [];
  const filtered = categoryFilter ? data.filter((r) => r.resourceCategory === categoryFilter) : data;

  return (
    <div className="page-container">
      <PageHeader
        title="Resources & Bays"
        subtitle={`${data.length} resources configured`}
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Admin' }, { label: 'Resources' }]}
        actions={
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="input-field w-auto">
            <option value="">All Categories</option>
            <option value="BAY">Bay</option>
            <option value="OVERFLOW">Overflow</option>
            <option value="LIGHT_SLOT">Light Slot</option>
          </select>
        }
      />

      {resQuery.isLoading && <LoadingState message="Loading resources..." />}

      {filtered.length === 0 && resQuery.isSuccess && (
        <EmptyState title="No resources" description="No work resources configured for this site." />
      )}

      {filtered.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Category</th>
                <th>Max Weight</th>
                <th>Lift</th>
                <th>Capabilities</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="table-row">
                  <td className="font-mono text-xs font-bold text-slate-700">{r.code}</td>
                  <td className="font-medium text-slate-900">{r.name}</td>
                  <td>
                    <span className={`badge text-[10px] ${r.resourceCategory === 'BAY' ? 'bg-blue-50 text-blue-700' : r.resourceCategory === 'OVERFLOW' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                      {r.resourceCategory}
                    </span>
                  </td>
                  <td className="text-xs text-slate-500">{r.maxVehicleWeight ?? 'Any'}</td>
                  <td className="text-xs text-slate-500">{r.liftType ?? '--'}</td>
                  <td className="text-xs">
                    <div className="flex gap-1">
                      {r.hasAlignment && <span className="badge bg-violet-50 text-violet-700 text-[9px]">Align</span>}
                      {r.hasDiagnostics && <span className="badge bg-indigo-50 text-indigo-700 text-[9px]">Diag</span>}
                      {r.requiresMechanic && <span className="badge bg-slate-100 text-slate-500 text-[9px]">Mech</span>}
                    </div>
                  </td>
                  <td><StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                  <td>
                    <button
                      onClick={() => toggleMutation.mutate({ id: r.id, isActive: !r.isActive })}
                      disabled={toggleMutation.isPending}
                      className={`text-xs font-medium ${r.isActive ? 'text-red-500 hover:underline' : 'text-emerald-600 hover:underline'}`}
                    >
                      {r.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
