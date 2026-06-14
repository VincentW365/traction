'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';

const ALLOWED_ROLES = ['ADMIN', 'MANAGER'];

// Shape returned by GET /maintenance/due-vehicles (MaintenanceRecommendation + vehicle.customer).
interface DueRow {
  id: string;
  serviceTypeCode: string;
  nextDueDate: string | null;
  nextDueOdometer: number | null;
  vehicle: {
    id: string;
    plateNumber: string;
    make: string | null;
    model: string | null;
    odometer: number | null;
    customer: { id: string; firstName: string; lastName: string; phone: string | null } | null;
  };
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function DueForContactPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const [thresholdMiles, setThresholdMiles] = useState(500);
  const [thresholdDays, setThresholdDays] = useState(30);

  const dueQuery = useQuery<DueRow[]>({
    queryKey: ['due-for-contact', siteId, thresholdMiles, thresholdDays],
    queryFn: () =>
      api.get<DueRow[]>(
        `/maintenance/due-vehicles?siteId=${siteId}&thresholdMiles=${thresholdMiles}&thresholdDays=${thresholdDays}`,
      ),
    enabled: allowed && !!siteId,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Due for Contact" subtitle="Customers approaching their next service" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">You do not have permission to view this report.</p>
        </div>
      </div>
    );
  }

  const rows = dueQuery.data ?? [];

  return (
    <div className="page-container">
      <PageHeader
        title="Due for Contact"
        subtitle="Customers approaching their next service (by mileage pattern or due date)"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Reports', href: '/reports' },
          { label: 'Due for Contact' },
        ]}
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              Within
              <input
                type="number"
                value={thresholdMiles}
                onChange={(e) => setThresholdMiles(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="input-field w-20"
              />
              mi
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              or
              <input
                type="number"
                value={thresholdDays}
                onChange={(e) => setThresholdDays(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="input-field w-20"
              />
              days
            </label>
          </div>
        }
      />

      {dueQuery.isLoading && <LoadingState message="Finding vehicles due for service..." />}

      {dueQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load this report.</p>
        </div>
      )}

      {dueQuery.data && rows.length === 0 && (
        <EmptyState
          title="No customers due for contact"
          description="No vehicles are within the selected mileage/date thresholds."
        />
      )}

      {rows.length > 0 && (
        <div className="table-container">
          <table className="w-full text-sm">
            <thead className="table-header">
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>Vehicle</th>
                <th>Service due</th>
                <th className="text-right">Due date</th>
                <th className="text-right">Due odometer</th>
                <th className="text-right">Current</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cust = r.vehicle.customer;
                const vehicleLabel = [r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ') || r.vehicle.plateNumber;
                return (
                  <tr key={r.id} className="table-row">
                    <td className="text-slate-700">
                      {cust ? (
                        <Link href={`/customers/${cust.id}`} className="text-blue-600 hover:underline">
                          {cust.firstName} {cust.lastName}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="text-slate-600 font-mono text-xs">{cust?.phone ?? '—'}</td>
                    <td className="text-slate-600">
                      <Link href={`/vehicles/${r.vehicle.id}`} className="text-blue-600 hover:underline">{vehicleLabel}</Link>
                      <span className="text-slate-400 ml-1.5 text-xs">{r.vehicle.plateNumber}</span>
                    </td>
                    <td className="text-slate-600 font-mono text-xs">{r.serviceTypeCode}</td>
                    <td className="text-right text-slate-600 whitespace-nowrap">{fmtDate(r.nextDueDate)}</td>
                    <td className="text-right text-slate-600 tabular-nums">{r.nextDueOdometer != null ? r.nextDueOdometer.toLocaleString() : '—'}</td>
                    <td className="text-right text-slate-500 tabular-nums">{r.vehicle.odometer != null ? r.vehicle.odometer.toLocaleString() : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
