'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '../../../../../lib/api-client';
import { PageHeader } from '../../../../../components/ui/page-header';

// CR-2026-048 — consolidated roles. ADMIN is the full-access role, shown as "Manager".
const ROLES = [
  { code: 'SERVICE_ADVISOR', label: 'Service Advisor' },
  { code: 'TECHNICIAN', label: 'Technician' },
  { code: 'ADMIN', label: 'Manager' },
];

export default function CreateStaffPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [roleCode, setRoleCode] = useState('SERVICE_ADVISOR');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');

  const createMutation = useMutation({
    mutationFn: () =>
      api.post('/staff', {
        fullName,
        email: email || undefined,
        roleCode,
        temporaryPassword,
        employeeCode: roleCode === 'TECHNICIAN' && employeeCode ? employeeCode : undefined,
      }),
    onSuccess: (data: any) => {
      router.push(`/admin/staff/${data.id}`);
    },
  });

  const canSubmit = fullName.trim() && temporaryPassword.length >= 8;

  return (
    <div className="page-container max-w-2xl">
      <PageHeader
        title="Add Staff Member"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Staff', href: '/admin/staff' },
          { label: 'New' },
        ]}
      />

      <div className="card">
        <div className="card-body space-y-5">
          <div>
            <label className="input-label">Full Name *</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="input-field"
              placeholder="e.g., John Smith"
            />
          </div>

          <div>
            <label className="input-label">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="e.g., john@bert.local"
            />
          </div>

          <div>
            <label className="input-label">Role *</label>
            <select
              value={roleCode}
              onChange={(e) => setRoleCode(e.target.value)}
              className="input-field"
            >
              {ROLES.map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </select>
          </div>

          {roleCode === 'TECHNICIAN' && (
            <div>
              <label className="input-label">Employee Code</label>
              <input
                type="text"
                value={employeeCode}
                onChange={(e) => setEmployeeCode(e.target.value.toUpperCase())}
                className="input-field"
                placeholder="e.g., TECH-006"
              />
              <p className="text-xs text-slate-400 mt-1">Auto-creates technician profile when provided.</p>
            </div>
          )}

          <div>
            <label className="input-label">Temporary Password *</label>
            <input
              type="password"
              value={temporaryPassword}
              onChange={(e) => setTemporaryPassword(e.target.value)}
              className="input-field"
              placeholder="Minimum 8 characters"
            />
          </div>

          {createMutation.isError && (
            <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create staff member'}
            </div>
          )}

          <div className="flex items-center gap-3 pt-3 border-t border-slate-100">
            <button
              onClick={() => createMutation.mutate()}
              disabled={!canSubmit || createMutation.isPending}
              className="btn-primary"
            >
              {createMutation.isPending ? 'Creating...' : 'Create Staff Member'}
            </button>
            <button
              onClick={() => router.push('/admin/staff')}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
