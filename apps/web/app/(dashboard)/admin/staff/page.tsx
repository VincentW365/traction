'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { StatusBadge } from '../../../../components/status-badge';

interface StaffMember {
  id: string;
  fullName: string;
  email: string | null;
  roleCode: string;
  status: string;
  siteId: string | null;
  createdAt: string;
  technician: {
    id: string;
    employeeCode: string;
    status: string;
  } | null;
}

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  SERVICE_ADVISOR: 'Service Advisor',
  FRONT_DESK: 'Front Desk',
  TECHNICIAN: 'Technician',
  PARTS_STAFF: 'Parts Staff',
  TRANSPORT_COORDINATOR: 'Transport',
};

export default function StaffDirectoryPage() {
  const siteId = useSiteId();
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  const staffQuery = useQuery<StaffMember[]>({
    queryKey: ['staff', siteId, roleFilter, statusFilter, search],
    queryFn: () => {
      const params = new URLSearchParams();
      if (siteId) params.set('siteId', siteId);
      if (roleFilter) params.set('roleCode', roleFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (search) params.set('search', search);
      return api.get(`/staff?${params.toString()}`);
    },
  });

  const data = staffQuery.data ?? [];

  return (
    <div className="page-container">
      <PageHeader
        title="Staff Directory"
        subtitle={`${data.length} staff members`}
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Admin' },
          { label: 'Staff' },
        ]}
        actions={
          <Link href="/admin/staff/new" className="btn-primary">
            Add Staff
          </Link>
        }
      />

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input-field w-64"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="input-field w-auto"
        >
          <option value="">All Roles</option>
          {Object.entries(ROLE_LABELS).map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="input-field w-auto"
        >
          <option value="">All Statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>

      {staffQuery.isLoading && <LoadingState message="Loading staff..." />}

      {staffQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load staff directory.</p>
        </div>
      )}

      {data.length === 0 && staffQuery.isSuccess && (
        <EmptyState
          title="No staff members found"
          description="Try adjusting your filters or add a new staff member."
        />
      )}

      {data.length > 0 && (
        <div className="table-container">
          <table className="w-full">
            <thead>
              <tr className="table-header">
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Technician</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((staff) => (
                <tr key={staff.id} className="table-row">
                  <td className="font-medium text-slate-900">{staff.fullName}</td>
                  <td className="text-slate-500">{staff.email ?? '--'}</td>
                  <td>
                    <span className="badge bg-slate-100 text-slate-700">
                      {ROLE_LABELS[staff.roleCode] ?? staff.roleCode}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={staff.status} />
                  </td>
                  <td>
                    {staff.technician ? (
                      <span className="text-xs font-mono text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                        {staff.technician.employeeCode}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">--</span>
                    )}
                  </td>
                  <td>
                    <Link
                      href={`/admin/staff/${staff.id}`}
                      className="text-xs text-blue-600 hover:underline font-medium"
                    >
                      View
                    </Link>
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
