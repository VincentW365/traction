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
    // CR-2026-087 — senior technicians may be assigned a quality check.
    isSenior: boolean;
    homeSiteId: string | null;
    skills: Array<{
      id: string;
      skillCode: string;
      proficiencyLevel: number;
      isPrimary: boolean;
    }>;
  } | null;
}

// CR-2026-048 — consolidated roles. ADMIN is shown as "Manager".
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Manager', SERVICE_ADVISOR: 'Service Advisor', TECHNICIAN: 'Technician',
};

export default function StaffDetailPage() {
  const params = useParams();
  const staffId = params.id as string;
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'profile' | 'technician' | 'activity'>('profile');

  // Add skill form state
  const [newSkillCode, setNewSkillCode] = useState('');
  const [linkEmployeeCode, setLinkEmployeeCode] = useState('');

  const { data: staff, isLoading, error } = useQuery<StaffDetail>({
    queryKey: ['staff-detail', staffId],
    queryFn: () => api.get(`/staff/${staffId}`),
    enabled: !!staffId,
  });

  // CR-2026-067 — canonical skill codes for the add-skill dropdown, derived from the
  // service catalogue (every service's requiredSkillCode) plus the GENERAL/LUBE baseline.
  const serviceTypesQuery = useQuery<Array<{ requiredSkillCode: string | null }>>({
    queryKey: ['service-types'],
    queryFn: () => api.get('/service-types'),
  });
  const knownSkillCodes = Array.from(
    new Set([
      'GENERAL',
      'LUBE',
      ...(serviceTypesQuery.data ?? [])
        .map((s) => s.requiredSkillCode)
        .filter((c): c is string => !!c),
    ]),
  ).sort();

  // CR-2026-099 — manager password reset.
  const [showReset, setShowReset] = useState(false);
  const [resetPw, setResetPw] = useState('');
  const resetMutation = useMutation({
    mutationFn: () => api.post(`/staff/${staffId}/reset-password`, { temporaryPassword: resetPw }),
    onSuccess: () => setResetPw(''),
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
    mutationFn: (data: { skillCode: string }) =>
      api.post(`/technicians/${staff?.technician?.id}/skills`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] });
      setNewSkillCode('');
    },
  });

  // CR-2026-087 — mark this technician senior (eligible to be assigned a quality check).
  // CR-2026-118 §6 — twelve technician accounts were recorded as "J. Walters":
  // an initial and a surname. The greeting cannot show a first name that was
  // never entered, and until now nothing in the UI let a manager enter one —
  // the API accepted fullName on PATCH /staff/:id, the screen never offered it.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const renameMutation = useMutation({
    mutationFn: (fullName: string) => api.patch(`/staff/${staffId}`, { fullName }),
    onSuccess: () => {
      setEditingName(false);
      queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] });
    },
  });
  const seniorityMutation = useMutation({
    mutationFn: (isSenior: boolean) =>
      api.patch(`/staff/${staffId}/technician/seniority`, { isSenior }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] }),
  });

  // CR-2026-067 — add every missing skill at once (so a technician can do everything).
  const addAllSkillsMutation = useMutation({
    mutationFn: (codes: string[]) =>
      Promise.all(
        codes.map((code) =>
          api.post(`/technicians/${staff?.technician?.id}/skills`, { skillCode: code }),
        ),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff-detail', staffId] }),
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
            {editingName ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => { e.preventDefault(); const v = nameDraft.trim(); if (v.length >= 2) renameMutation.mutate(v); }}
              >
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="First and last name"
                  className="input-field text-sm py-1 w-56"
                  aria-label="Full name"
                />
                <button type="submit" disabled={renameMutation.isPending || nameDraft.trim().length < 2} className="btn-primary text-xs">
                  {renameMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => setEditingName(false)} className="btn-secondary text-xs">Cancel</button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => { setNameDraft(staff.fullName); setEditingName(true); }}
                className="btn-secondary text-xs"
                title="Correct how this person's name is recorded"
              >
                Edit name
              </button>
            )}
            {renameMutation.isError && (
              <span className="text-xs text-red-600">{renameMutation.error instanceof Error ? renameMutation.error.message : 'The name could not be saved.'}</span>
            )}
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
              <button onClick={() => setShowReset(!showReset)} className="btn-secondary text-xs">
                Reset Password
              </button>
            </div>

            {/* CR-2026-099 — manager-set temporary password (forgot-password recovery).
                Ends the person's existing sessions. */}
            {showReset && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                <label className="input-label">Temporary password</label>
                <input
                  type="text"
                  value={resetPw}
                  onChange={(e) => setResetPw(e.target.value)}
                  placeholder="At least 8 characters, a letter and a number"
                  className="input-field text-sm"
                />
                {resetMutation.isError && (
                  <p className="text-xs text-red-600">{resetMutation.error instanceof Error ? resetMutation.error.message : 'Reset failed'}</p>
                )}
                {resetMutation.isSuccess && (
                  <p className="text-xs text-emerald-700">Password reset. Share the temporary password with {staff.fullName}; their old sessions are ended.</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => resetMutation.mutate()}
                    disabled={resetMutation.isPending || resetPw.length < 8}
                    className="btn-primary text-xs"
                  >
                    {resetMutation.isPending ? 'Resetting…' : 'Set Temporary Password'}
                  </button>
                  <button onClick={() => { setShowReset(false); setResetPw(''); }} className="btn-secondary text-xs">Cancel</button>
                </div>
              </div>
            )}
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

                  {/*
                    CR-2026-087 — seniority. Until now "senior technician sign-off"
                    was really just the manager role, so an actual senior technician
                    could not sign anything. This is the attribute that decides who
                    may be assigned a quality check.
                  */}
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={staff.technician.isSenior}
                        disabled={seniorityMutation.isPending}
                        onChange={(e) => seniorityMutation.mutate(e.target.checked)}
                        className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span>
                        <span className="text-sm font-medium text-slate-900">Senior technician</span>
                        <span className="block text-xs text-slate-500 mt-0.5">
                          Can be assigned a quality check and can sign off an inspection.
                          A technician can never pass the quality check on their own work.
                        </span>
                      </span>
                    </label>
                    {seniorityMutation.isError && (
                      <p className="text-xs text-red-600 mt-2">
                        {seniorityMutation.error instanceof Error ? seniorityMutation.error.message : 'Could not update seniority'}
                      </p>
                    )}
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
                            {/* CR-2026-119 — a skill is held or it is not. The 1–5 level was a
                                Phase-0 placeholder (TECH-002) that no assignment, QC or
                                scheduling decision ever read; showing it invited people to
                                set a number nothing would act on. */}
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

                  {/* Add skill form (CR-2026-067 — pick from known skills; no typing codes) */}
                  {(() => {
                    const existing = new Set(staff.technician.skills.map((s) => s.skillCode));
                    const available = knownSkillCodes.filter((c) => !existing.has(c));
                    return (
                      <div className="mt-4 pt-3 border-t border-slate-100 space-y-2">
                        <div className="flex items-end gap-2">
                          <div>
                            <label className="input-label">Skill</label>
                            <select
                              value={newSkillCode}
                              onChange={(e) => setNewSkillCode(e.target.value)}
                              className="input-field w-40"
                            >
                              <option value="">Select skill…</option>
                              {available.map((c) => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                          </div>
                          <button
                            onClick={() => addSkillMutation.mutate({ skillCode: newSkillCode })}
                            disabled={!newSkillCode || addSkillMutation.isPending}
                            className="btn-primary text-xs"
                          >
                            Add Skill
                          </button>
                          {available.length > 0 && (
                            <button
                              onClick={() => addAllSkillsMutation.mutate(available)}
                              disabled={addAllSkillsMutation.isPending}
                              className="btn-secondary text-xs"
                              title="Give this technician every skill"
                            >
                              {addAllSkillsMutation.isPending ? 'Adding…' : `Add all (${available.length})`}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}
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
          <Link href={`/admin/audit-logs`} className="text-xs text-blue-600 hover:underline mt-2 inline-block">
            View Audit Logs
          </Link>
        </div>
      )}
    </div>
  );
}
