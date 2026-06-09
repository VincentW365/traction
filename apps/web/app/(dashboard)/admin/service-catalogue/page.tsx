'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';

interface ServiceType {
  id: string;
  code: string;
  name: string;
  family: string;
  baseDurationMinutes: number;
  quickService: boolean;
  appointmentOnly: boolean;
  requiredSkillCode: string | null;
  requiredBayType: string | null;
  isActive?: boolean;
}

export default function ServiceCataloguePage() {
  const queryClient = useQueryClient();
  const [familyFilter, setFamilyFilter] = useState('');
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDuration, setEditDuration] = useState('');

  const stQuery = useQuery<ServiceType[]>({
    queryKey: ['service-types-admin'],
    queryFn: () => api.get('/service-types'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ code, data }: { code: string; data: any }) =>
      api.patch(`/service-types/${code}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-types-admin'] });
      setEditingCode(null);
    },
  });

  const data = stQuery.data ?? [];
  const families = [...new Set(data.map((s) => s.family))].sort();
  const filtered = familyFilter ? data.filter((s) => s.family === familyFilter) : data;

  function startEdit(st: ServiceType) {
    setEditingCode(st.code);
    setEditName(st.name);
    setEditDuration(String(st.baseDurationMinutes));
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Service Catalogue"
        subtitle={`${data.length} service types`}
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Admin' }, { label: 'Services' }]}
        actions={
          <select value={familyFilter} onChange={(e) => setFamilyFilter(e.target.value)} className="input-field w-auto">
            <option value="">All Families</option>
            {families.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        }
      />

      {stQuery.isLoading && <LoadingState message="Loading service types..." />}

      {filtered.length === 0 && stQuery.isSuccess && (
        <EmptyState title="No service types" description="No service types match the current filter." />
      )}

      {filtered.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Family</th>
                <th>Duration</th>
                <th>Quick</th>
                <th>Skill</th>
                <th>Bay</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((st) => (
                <tr key={st.code} className="table-row">
                  <td className="font-mono text-xs text-slate-600">{st.code}</td>
                  <td className="font-medium text-slate-900">
                    {editingCode === st.code ? (
                      <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="input-field text-xs w-40" />
                    ) : st.name}
                  </td>
                  <td className="text-slate-500">{st.family}</td>
                  <td>
                    {editingCode === st.code ? (
                      <input type="number" value={editDuration} onChange={(e) => setEditDuration(e.target.value)} className="input-field text-xs w-20" />
                    ) : (
                      <span className="text-slate-700">{st.baseDurationMinutes}m</span>
                    )}
                  </td>
                  <td>{st.quickService ? <span className="badge bg-emerald-50 text-emerald-700 text-[10px]">Yes</span> : '--'}</td>
                  <td className="text-xs text-slate-500">{st.requiredSkillCode ?? '--'}</td>
                  <td className="text-xs text-slate-500">{st.requiredBayType ?? '--'}</td>
                  <td>
                    {editingCode === st.code ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => updateMutation.mutate({ code: st.code, data: { name: editName, baseDurationMinutes: parseInt(editDuration, 10) } })}
                          disabled={updateMutation.isPending}
                          className="text-xs text-blue-600 hover:underline font-medium"
                        >Save</button>
                        <button onClick={() => setEditingCode(null)} className="text-xs text-slate-500 hover:underline">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => startEdit(st)} className="text-xs text-blue-600 hover:underline font-medium">Edit</button>
                    )}
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
