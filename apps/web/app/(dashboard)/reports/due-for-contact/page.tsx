'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { EmptyState } from '../../../../components/ui/empty-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../lib/export';
import {
  CustomerNotificationComposer,
  type ComposerContext,
} from '../../../../components/notification-composer';

const ALLOWED_ROLES = ['ADMIN'];

// Shape returned by GET /maintenance/due-vehicles (MaintenanceRecommendation + vehicle.customer
// + CR-2026-096 contact workflow fields).
interface DueRow {
  id: string;
  serviceTypeCode: string;
  nextDueDate: string | null;
  nextDueOdometer: number | null;
  contactStatus: 'NOT_CONTACTED' | 'CONTACTED' | 'BOOKED' | 'DEFERRED' | 'DO_NOT_CONTACT';
  lastContactedAt: string | null;
  lastContact: { channel: string; status: string; sentAt: string | null; createdAt: string } | null;
  vehicle: {
    id: string;
    plateNumber: string;
    make: string | null;
    model: string | null;
    odometer: number | null;
    customer: { id: string; firstName: string; lastName: string; phone: string | null; email: string | null } | null;
  };
}

const CONTACT_STATUS_LABELS: Record<DueRow['contactStatus'], string> = {
  NOT_CONTACTED: 'Contact due',
  CONTACTED: 'Contacted',
  BOOKED: 'Booked',
  DEFERRED: 'Deferred',
  DO_NOT_CONTACT: 'Do not contact',
};

const CONTACT_STATUS_STYLES: Record<DueRow['contactStatus'], string> = {
  NOT_CONTACTED: 'bg-amber-50 text-amber-700 border-amber-200',
  CONTACTED: 'bg-blue-50 text-blue-700 border-blue-200',
  BOOKED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DEFERRED: 'bg-slate-100 text-slate-600 border-slate-200',
  DO_NOT_CONTACT: 'bg-red-50 text-red-700 border-red-200',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function DueForContactPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const [thresholdMiles, setThresholdMiles] = useState(500);
  const [thresholdDays, setThresholdDays] = useState(30);
  const [composerCtx, setComposerCtx] = useState<ComposerContext | null>(null);

  // The person on this screen is about to CALL someone — they need "Tire Rotation",
  // not TIR-01. Names come from the catalogue; an unmapped code still shows itself.
  const servicesQuery = useQuery<Array<{ code: string; name: string }>>({
    queryKey: ['service-types-names'],
    queryFn: () => api.get('/service-types'),
    staleTime: 5 * 60_000,
  });
  const serviceName = (code: string) =>
    servicesQuery.data?.find((t) => t.code === code)?.name ?? code;

  const dueQuery = useQuery<DueRow[]>({
    queryKey: ['due-vehicles', siteId, thresholdMiles, thresholdDays],
    queryFn: () =>
      api.get<DueRow[]>(
        `/maintenance/due-vehicles?siteId=${siteId}&thresholdMiles=${thresholdMiles}&thresholdDays=${thresholdDays}`,
      ),
    enabled: allowed && !!siteId,
  });

  const statusMutation = useMutation<unknown, unknown, { id: string; contactStatus: DueRow['contactStatus'] }>({
    mutationFn: ({ id, contactStatus }) =>
      api.patch(`/maintenance/recommendations/${id}/contact-status`, { contactStatus }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['due-vehicles'] }),
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

  const buildExport = (): ExportDocument | null => {
    if (!dueQuery.data) return null;
    return {
      title: 'Due for Contact',
      filename: 'due-for-contact',
      subtitle: 'Customers approaching their next service (by mileage pattern or due date)',
      meta: [
        ['Threshold', `Within ${thresholdMiles} mi or ${thresholdDays} days`],
        ['Vehicles due', String(rows.length)],
      ],
      sections: [
        {
          columns: ['Customer', 'Phone', 'Vehicle', 'Plate', 'Service due', 'Due date', 'Due odometer', 'Current odometer', 'Last contact', 'Status'],
          rows: rows.map((r) => {
            const cust = r.vehicle.customer;
            const vehicleLabel = [r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ') || r.vehicle.plateNumber;
            return [
              cust ? `${cust.firstName} ${cust.lastName}` : '',
              cust?.phone ?? '',
              vehicleLabel,
              r.vehicle.plateNumber,
              serviceName(r.serviceTypeCode),
              fmtDate(r.nextDueDate),
              r.nextDueOdometer ?? '',
              r.vehicle.odometer ?? '',
              r.lastContactedAt ? `${fmtDate(r.lastContactedAt)}${r.lastContact ? ` — ${r.lastContact.channel} — ${r.lastContact.status}` : ''}` : 'Never',
              CONTACT_STATUS_LABELS[r.contactStatus],
            ];
          }),
        },
      ],
    };
  };

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
            <ExportMenu build={buildExport} disabled={!dueQuery.data} />
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
                <th>Contact</th>
                <th>Vehicle</th>
                <th>Service due</th>
                <th className="text-right">Due date</th>
                <th className="text-right">Miles</th>
                <th>Last contact</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cust = r.vehicle.customer;
                const vehicleLabel = [r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ') || r.vehicle.plateNumber;
                const hasPhone = !!cust?.phone;
                const hasEmail = !!cust?.email;
                return (
                  <tr key={r.id} className="table-row">
                    <td className="text-slate-700">
                      {cust ? (
                        <Link href={`/customers/${cust.id}`} className="text-blue-600 hover:underline">
                          {cust.firstName} {cust.lastName}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="whitespace-nowrap">
                      {hasPhone && <span className="badge bg-blue-50 text-blue-700 text-[10px] mr-1" title={cust!.phone!}>SMS</span>}
                      {hasEmail && <span className="badge bg-indigo-50 text-indigo-700 text-[10px]" title={cust!.email!}>Email</span>}
                      {!hasPhone && !hasEmail && <span className="badge bg-red-50 text-red-600 text-[10px]">No contact info</span>}
                    </td>
                    <td className="text-slate-600">
                      <Link href={`/vehicles/${r.vehicle.id}`} className="text-blue-600 hover:underline">{vehicleLabel}</Link>
                      <span className="text-slate-400 ml-1.5 text-xs">{r.vehicle.plateNumber}</span>
                    </td>
                    <td className="text-slate-700">
                      {serviceName(r.serviceTypeCode)}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {r.nextDueDate && new Date(r.nextDueDate) < new Date() ? (
                        <span className="text-red-600 font-semibold" title="Past due">
                          {fmtDate(r.nextDueDate)} · overdue
                        </span>
                      ) : (
                        <span className="text-slate-600">{fmtDate(r.nextDueDate)}</span>
                      )}
                    </td>
                    <td className="text-right text-slate-600 tabular-nums text-xs whitespace-nowrap">
                      {r.nextDueOdometer != null ? `due ${r.nextDueOdometer.toLocaleString()}` : '—'}
                      {r.vehicle.odometer != null && <span className="text-slate-400"> / {r.vehicle.odometer.toLocaleString()}</span>}
                    </td>
                    <td className="text-xs text-slate-500 whitespace-nowrap">
                      {r.lastContactedAt ? (
                        <span title={r.lastContact?.status ?? ''}>
                          {fmtDate(r.lastContactedAt)}
                          {r.lastContact ? ` — ${r.lastContact.channel} — ${r.lastContact.status}` : ''}
                        </span>
                      ) : 'Never'}
                    </td>
                    <td>
                      <select
                        value={r.contactStatus}
                        onChange={(e) => statusMutation.mutate({ id: r.id, contactStatus: e.target.value as DueRow['contactStatus'] })}
                        className={`text-[11px] font-medium rounded-full border px-2 py-0.5 cursor-pointer ${CONTACT_STATUS_STYLES[r.contactStatus]}`}
                        title="Follow-up status (separate from message delivery)"
                      >
                        {(Object.keys(CONTACT_STATUS_LABELS) as Array<DueRow['contactStatus']>).map((s) => (
                          <option key={s} value={s}>{CONTACT_STATUS_LABELS[s]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="text-right">
                      {cust && (hasPhone || hasEmail) && r.contactStatus !== 'DO_NOT_CONTACT' && (
                        <button
                          onClick={() =>
                            setComposerCtx({
                              reason: 'SERVICE_DUE',
                              customerId: cust.id,
                              vehicleId: r.vehicle.id,
                              recommendationId: r.id,
                            })
                          }
                          className="btn-primary text-xs px-3 py-1 whitespace-nowrap"
                        >
                          Contact Customer
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {composerCtx && (
        <CustomerNotificationComposer
          open
          context={composerCtx}
          onClose={() => setComposerCtx(null)}
          onSent={() => queryClient.invalidateQueries({ queryKey: ['due-vehicles'] })}
        />
      )}
    </div>
  );
}
