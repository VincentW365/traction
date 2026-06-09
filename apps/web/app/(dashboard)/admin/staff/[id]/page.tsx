'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../../lib/api-client';
import { PageHeader } from '../../../../../components/ui/page-header';
import { LoadingState } from '../../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../../components/status-badge';

interface StaffDetail {
  id: string;
  fullName: string;
  email: string | null;
  roleCode: string;
  status: string;
  siteId: string | null;
  createdAt: string;
  updatedAt: string;
  technician: {
    id: string;
    employeeCode: string;
    status: string;
    homeSiteId: string | null;
    skills: Array<{
      id: string;
      skillCode: string;
      proficiencyLevel: number;
      isPrimary: boolean;
    }>;
  } | null;
}

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin', MANAGER: 'Manager', SERVICE_ADVISOR: 'Service Advisor',
  FRONT_DESK: 'Front Desk', TECHNICIAN: 'Technician', PARTS_STAFF: 'Parts Staff',
  TRANSPORT_COORDINATOR: 'Transport',
};

export default function StaffDetailPage() {
  const params = useParams();
  const staffId = params.id as string;
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'profile' | 'technician' | 'activity'>('profile');

  // Add skill form state
  const [newSkillCode, setNewSkillCode] = useState('');
  const [newSkillLevel, setNewSkillLevel] = useState(1);
  const [linkEmployeeCode, setLinkEmployeeCode] = useState('');

  const { data: staff, isLoading, error } = useQuery<StaffDetail>({
    queryKey: ['staff-detail', staffId],
    queryFn: () => api.get(`/staff/${staffId}`),
    enabled: !!staffId,
  });

  const deactivateMutation = useMutation({
    mutationFn: () => api.post(`/staff/${staffId}/deactivate`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] }),
  });

  const reactivateMutation = useMutation({
    mutationFn: () => api.post(`/staff/${staffId}/reactivate`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] }),
  });

  const linkTechMutation = useMutation({
    mutationFn: (employeeCode: string) => api.post(`/staff/${staffId}/link-technician`, { employeeCode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] });
      setLinkEmployeeCode('');
    },
  });

  const addSkillMutation = useMutation({
    mutationFn: (data: { skillCode: string; proficiencyLevel: number }) =>
      api.post(`/technicians/${staff?.technician?.id}/skills`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] });
      setNewSkillCode('');
      setNewSkillLevel(1);
    },
  });

  const removeSkillMutation = useMutation({
    mutationFn: (skillId: string) =>
      api.delete(`/technicians/${staff?.technician?.id}/skills/${skillId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] }),
  });

  if (isLoading) {
    return (
      <div className="page-container">
        <LoadingState message="Loading staff detail..." />
      </div>
    );
  }

  if (error || !staff) {
    return (
      <div className="page-container">
        <PageHeader
          title="Staff Member"
          breadcrumbs={[{ label: 'Staff', href: '/admin/staff' }, { label: 'Error' }]}
        />
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load staff member.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title={staff.fullName}
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Staff', href: '/admin/staff' },
          { label: staff.fullName },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={staff.status} />
            <span className="badge bg-slate-100 text-slate-700">
              {ROLE_LABELS[staff.roleCode] ?? staff.roleCode}
            </span>
          </div>
        }
      />

      {/* Tab navigation */}
      <div className="flex gap-0 border-b border-slate-200 mb-5">
        {(['profile', 'technician', 'activity'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Profile tab */}
      {activeTab === 'profile' && (
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Profile Information</h2>
          </div>
          <div className="card-body">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <div>
                <div className="input-label">Full Name</div>
                <p className="text-sm font-medium text-slate-900">{staff.fullName}</p>
              </div>
              <div>
                <div className="input-label">Email</div>
                <p className="text-sm font-medium text-slate-900">{staff.email ?? 'Not provided'}</p>
              </div>
              <div>
                <div className="input-label">Role</div>
                <p className="text-sm font-medium text-slate-900">{ROLE_LABELS[staff.roleCode] ?? staff.roleCode}</p>
              </div>
              <div>
                <div className="input-label">Status</div>
                <div className="mt-0.5"><StatusBadge status={staff.status} /></div>
              </div>
              <div>
                <div className="input-label">Member Since</div>
                <p className="text-sm font-medium text-slate-900">
                  {new Date(staff.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>

            {/* Status actions */}
            <div className="flex items-center gap-3 mt-6 pt-4 border-t border-slate-100">
              {staff.status === 'ACTIVE' ? (
                <button
                  onClick={() => deactivateMutation.mutate()}
                  disabled={deactivateMutation.isPending}
                  className="btn-danger text-xs"
                >
                  {deactivateMutation.isPending ? 'Deactivating...' : 'Deactivate'}
                </button>
              ) : (
                <button
                  onClick={() => reactivateMutation.mutate()}
                  disabled={reactivateMutation.isPending}
                  className="btn-success text-xs"
                >
                  {reactivateMutation.isPending ? 'Reactivating...' : 'Reactivate'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Technician tab */}
      {activeTab === 'technician' && (
        <div className="space-y-4">
          {staff.technician ? (
            <>
              <div className="card">
                <div className="card-header">
                  <h2 className="text-sm font-semibold text-slate-900">Technician Profile</h2>
                </div>
                <div className="card-body">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="input-label">Employee Code</div>
                      <p className="text-sm font-bold font-mono text-blue-700">{staff.technician.employeeCode}</p>
                    </div>
                    <div>
                      <div className="input-label">Status</div>
                      <div className="mt-0.5"><StatusBadge status={staff.technician.status} /></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Skills */}
              <div className="card">
                <div className="card-header flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Skills
                    <span className="ml-2 badge bg-slate-100 text-slate-600">{staff.technician.skills.length}</span>
                  </h2>
                </div>
                <div className="card-body">
                  {staff.technician.skills.length === 0 ? (
                    <p className="text-sm text-slate-500">No skills assigned.</p>
                  ) : (
                    <div className="space-y-2">
                      {staff.technician.skills.map((skill) => (
                        <div key={skill.id} className="flex items-center justify-between border border-slate-200 rounded-md px-3 py-2">
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-mono font-medium text-slate-900">{skill.skillCode}</span>
                            <span className="text-xs text-slate-500">Level {skill.proficiencyLevel}</span>
                            {skill.isPrimary && (
                              <span className="badge bg-blue-50 text-blue-700 text-[10px]">Primary</span>
                            )}
                          </div>
                          <button
                            onClick={() => removeSkillMutation.mutate(skill.id)}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add skill form */}
                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-end gap-2">
                    <div>
                      <label className="input-label">Skill Code</label>
                      <input
                        type="text"
                        value={newSkillCode}
                        onChange={(e) => setNewSkillCode(e.target.value.toUpperCase())}
                        placeholder="e.g., BRAKE"
                        className="input-field w-32"
                      />
                    </div>
                    <div>
                      <label className="input-label">Level</label>
                      <select
                        value={newSkillLevel}
                        onChange={(e) => setNewSkillLevel(Number(e.target.value))}
                        className="input-field w-20"
                      >
                        {[1, 2, 3, 4, 5].map((l) => (
                          <option key={l} value={l}>{l}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={() => addSkillMutation.mutate({ skillCode: newSkillCode, proficiencyLevel: newSkillLevel })}
                      disabled={!newSkillCode || addSkillMutation.isPending}
                      className="btn-primary text-xs"
                    >
                      Add Skill
                    </button>
                  </div>
                  {addSkillMutation.isError && (
                    <p className="text-xs text-red-600 mt-2">
                      {addSkillMutation.error instanceof Error ? addSkillMutation.error.message : 'Failed to add skill'}
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="card p-6">
              <p className="text-sm text-slate-500 mb-4">This staff member is not linked to a technician profile.</p>
              <div className="flex items-end gap-2">
                <div>
                  <label className="input-label">Employee Code</label>
                  <input
                    type="text"
                    value={linkEmployeeCode}
                    onChange={(e) => setLinkEmployeeCode(e.target.value.toUpperCase())}
                    placeholder="e.g., TECH-006"
                    className="input-field w-40"
                  />
                </div>
                <button
                  onClick={() => linkTechMutation.mutate(linkEmployeeCode)}
                  disabled={!linkEmployeeCode || linkTechMutation.isPending}
                  className="btn-primary text-xs"
                >
                  {linkTechMutation.isPending ? 'Linking...' : 'Link as Technician'}
                </button>
              </div>
              {linkTechMutation.isError && (
                <p className="text-xs text-red-600 mt-2">
                  {linkTechMutation.error instanceof Error ? linkTechMutation.error.message : 'Failed to link technician'}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Activity tab */}
      {activeTab === 'activity' && (
        <div className="card p-6 text-center">
          <p className="text-sm text-slate-500">Audit log for this user will be loaded from the existing audit-logs endpoint.</p>
          <Link href={`/admin/settings`} className="text-xs text-blue-600 hover:underline mt-2 inline-block">
            View Audit Logs
          </Link>
        </div>
      )}
    </div>
  );
}
