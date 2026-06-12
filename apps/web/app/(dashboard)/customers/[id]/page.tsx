'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { StatusBadge } from '../../../../components/status-badge';

interface Vehicle {
  id: string;
  vehicleCode: string;
  plateNumber: string;
  vin: string | null;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  color: string | null;
  odometer: number | null;
  weightClass: string | null;
}
interface RecentVisit {
  id: string;
  status: string;
  sourceType: string;
  visitedAt: string | null;
}
// CR-2026-021: formatted phones, staff-only notes, gated import metadata.
interface CustomerDetail {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phones: string[];
  phonesFlagged: boolean;
  email: string | null;
  loyaltyNumber: string | null;
  hasLoyalty: boolean;
  notificationOptInSms: boolean;
  notificationOptInEmail: boolean;
  staffNotes: string | null;
  vehicleCount: number;
  vehicles: Vehicle[];
  recentVisits: RecentVisit[];
  createdAt: string;
  importMeta?: { batchId: string; rawName: string } | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ConsentBadge({ on }: { on: boolean }) {
  return on ? (
    <span className="badge bg-emerald-50 text-emerald-700">Opted in</span>
  ) : (
    <span className="badge bg-slate-100 text-slate-500">Opted out</span>
  );
}

export default function CustomerDetailPage() {
  const params = useParams();
  const customerId = params.id as string;
  const queryClient = useQueryClient();

  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [vPlate, setVPlate] = useState('');
  const [vVin, setVVin] = useState('');
  const [vMake, setVMake] = useState('');
  const [vModel, setVModel] = useState('');
  const [vYear, setVYear] = useState('');
  const [vColor, setVColor] = useState('');
  const [vOdometer, setVOdometer] = useState('');

  const [editingLoyalty, setEditingLoyalty] = useState(false);
  const [loyaltyInput, setLoyaltyInput] = useState('');

  const { data: customer, isLoading, error } = useQuery<CustomerDetail>({
    queryKey: ['customer', customerId],
    queryFn: () => api.get(`/customers/${customerId}`),
    enabled: !!customerId,
  });

  // Check-in is an appointment action: only offer it when this customer has a
  // CONFIRMED appointment scheduled for today at this site. Fails closed (the
  // button stays hidden) if the lookup errors or returns nothing.
  const siteId = useSiteId();
  const today = new Date().toISOString().split('T')[0];
  const checkinableQuery = useQuery<Array<{ id: string; customer: { id: string } | null }>>({
    queryKey: ['customer-checkinable', customerId, siteId, today],
    queryFn: () => api.get(`/appointments?siteId=${siteId}&date=${today}&status=CONFIRMED`),
    enabled: !!customerId && !!siteId,
  });
  const hasCheckinableToday = (checkinableQuery.data ?? []).some((a) => a.customer?.id === customerId);

  const addVehicleMutation = useMutation({
    mutationFn: () =>
      api.post('/vehicles', {
        customerId,
        plateNumber: vPlate,
        vin: vVin || undefined,
        make: vMake || undefined,
        model: vModel || undefined,
        modelYear: vYear ? parseInt(vYear, 10) : undefined,
        color: vColor || undefined,
        odometer: vOdometer ? parseInt(vOdometer, 10) : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setShowAddVehicle(false);
      setVPlate(''); setVVin(''); setVMake(''); setVModel('');
      setVYear(''); setVColor(''); setVOdometer('');
    },
  });

  // Edit loyalty number (empty string removes membership). Modification of a
  // non-sandbox customer is blocked server-side while in Dev Sandbox Mode.
  const updateLoyaltyMutation = useMutation({
    mutationFn: () => api.patch(`/customers/${customerId}`, { loyaltyNumber: loyaltyInput.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setEditingLoyalty(false);
    },
  });

  if (isLoading) {
    return <div className="page-container"><LoadingState message="Loading customer..." /></div>;
  }
  if (error) {
    return (
      <div className="page-container">
        <PageHeader title="Customer" breadcrumbs={[{ label: 'Customers', href: '/customers' }, { label: 'Error' }]} />
        <div className="card"><div className="card-body">
          <div className="flex items-center gap-3 text-red-700">
            <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <span className="text-sm">{(error as Error).message}</span>
          </div>
        </div></div>
        <div className="mt-4"><Link href="/customers" className="btn-secondary text-sm">Back to Customers</Link></div>
      </div>
    );
  }
  if (!customer) return null;

  const fullName = `${customer.firstName} ${customer.lastName}`;
  const initials = `${customer.firstName[0] ?? ''}${customer.lastName[0] ?? ''}`.toUpperCase();

  return (
    <div className="page-container">
      <PageHeader
        title={fullName}
        breadcrumbs={[{ label: 'Customers', href: '/customers' }, { label: fullName }]}
        actions={
          <div className="flex items-center gap-2">
            {customer.hasLoyalty && <span className="badge bg-amber-50 text-amber-700">★ Loyalty</span>}
            <span className="badge bg-slate-100 text-slate-700 font-mono text-xs">{customer.customerNumber}</span>
          </div>
        }
      />

      {/* Identity + key cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Customer Identity */}
        <div className="card">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Customer Identity</h2></div>
          <div className="card-body flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-semibold">{initials || '?'}</div>
            <div>
              <p className="text-base font-semibold text-slate-900">{fullName}</p>
              <p className="text-xs text-slate-500">Customer since {fmtDate(customer.createdAt)}</p>
            </div>
          </div>
        </div>

        {/* Bert's Account Details */}
        <div className="card">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Bert&apos;s Account Details</h2></div>
          <div className="card-body grid grid-cols-2 gap-x-6 gap-y-3">
            <div><div className="input-label">Customer #</div><p className="font-mono text-sm text-slate-900">{customer.customerNumber}</p></div>
            <div><div className="input-label">Created</div><p className="text-sm text-slate-900">{fmtDate(customer.createdAt)}</p></div>
          </div>
        </div>

        {/* Contact Details — phone only here, after opening the record */}
        <div className="card">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Contact Details</h2></div>
          <div className="card-body grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <div>
              <div className="input-label">Phone{customer.phones.length > 1 ? 's' : ''}</div>
              {customer.phones.length === 0 ? (
                <p className="text-sm text-slate-500">No phone on file</p>
              ) : (
                <ul className="space-y-0.5">
                  {customer.phones.map((p, i) => <li key={i} className="text-sm font-medium text-slate-900">{p}</li>)}
                </ul>
              )}
              {customer.phonesFlagged && <p className="text-xs text-amber-600 mt-1">⚠ Multiple/unverified — confirm with customer</p>}
            </div>
            <div>
              <div className="input-label">Email</div>
              <p className="text-sm font-medium text-slate-900 break-all">{customer.email ?? 'Not provided'}</p>
            </div>
          </div>
        </div>

        {/* Loyalty Status */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Loyalty Status</h2>
            {!editingLoyalty && (
              <button
                onClick={() => { setLoyaltyInput(customer.loyaltyNumber ?? ''); setEditingLoyalty(true); }}
                className="text-xs text-blue-600 hover:underline font-medium"
              >
                Edit
              </button>
            )}
          </div>
          <div className="card-body">
            {editingLoyalty ? (
              <div className="space-y-3">
                <div>
                  <label className="input-label">Loyalty Number</label>
                  <input
                    type="text"
                    value={loyaltyInput}
                    onChange={(e) => setLoyaltyInput(e.target.value)}
                    className="input-field"
                    placeholder="Leave blank to remove membership"
                  />
                </div>
                {updateLoyaltyMutation.isError && (
                  <p className="text-xs text-red-600">{updateLoyaltyMutation.error instanceof Error ? updateLoyaltyMutation.error.message : 'Failed to update loyalty'}</p>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={() => updateLoyaltyMutation.mutate()} disabled={updateLoyaltyMutation.isPending} className="btn-primary text-xs">
                    {updateLoyaltyMutation.isPending ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={() => setEditingLoyalty(false)} disabled={updateLoyaltyMutation.isPending} className="btn-secondary text-xs">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  {customer.hasLoyalty
                    ? <span className="badge bg-amber-50 text-amber-700">★ Member</span>
                    : <span className="badge bg-slate-100 text-slate-500">Not a loyalty member</span>}
                </div>
                {customer.loyaltyNumber && (
                  <div className="mt-3"><div className="input-label">Loyalty Number</div><p className="font-mono text-sm text-slate-900">{customer.loyaltyNumber}</p></div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Notification Consent */}
        <div className="card">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Preferences &amp; Consent</h2></div>
          <div className="card-body grid grid-cols-2 gap-x-6 gap-y-3">
            <div><div className="input-label">SMS Notifications</div><ConsentBadge on={customer.notificationOptInSms} /></div>
            <div><div className="input-label">Email Notifications</div><ConsentBadge on={customer.notificationOptInEmail} /></div>
          </div>
        </div>

        {/* Notes — staff notes only (import metadata never shown here) */}
        <div className="card">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Notes</h2></div>
          <div className="card-body">
            {customer.staffNotes ? (
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{customer.staffNotes}</p>
            ) : (
              <p className="text-sm text-slate-400">No notes.</p>
            )}
          </div>
        </div>
      </div>

      {/* Vehicles */}
      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            Vehicles
            <span className="ml-2 badge bg-slate-100 text-slate-600">{customer.vehicleCount}</span>
          </h2>
          <button onClick={() => setShowAddVehicle(!showAddVehicle)} className={showAddVehicle ? 'text-xs text-slate-500 hover:text-slate-700' : 'text-xs text-blue-600 hover:underline font-medium'}>
            {showAddVehicle ? 'Cancel' : '+ Add Vehicle'}
          </button>
        </div>
        <div className="card-body">
          {showAddVehicle && (
            <div className="mb-4 pb-4 border-b border-slate-100 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div><label className="input-label">Plate Number *</label><input type="text" value={vPlate} onChange={(e) => setVPlate(e.target.value.toUpperCase())} className="input-field" placeholder="e.g., 1234AB" /></div>
                <div><label className="input-label">Make</label><input type="text" value={vMake} onChange={(e) => setVMake(e.target.value)} className="input-field" placeholder="e.g., Toyota" /></div>
                <div><label className="input-label">Model</label><input type="text" value={vModel} onChange={(e) => setVModel(e.target.value)} className="input-field" placeholder="e.g., Corolla" /></div>
                <div><label className="input-label">Year</label><input type="number" value={vYear} onChange={(e) => setVYear(e.target.value)} className="input-field" placeholder="e.g., 2020" /></div>
                <div><label className="input-label">Color</label><input type="text" value={vColor} onChange={(e) => setVColor(e.target.value)} className="input-field" placeholder="e.g., Silver" /></div>
                <div><label className="input-label">Odometer</label><input type="number" value={vOdometer} onChange={(e) => setVOdometer(e.target.value)} className="input-field" placeholder="e.g., 45000" /></div>
              </div>
              <div><label className="input-label">Chassis Number/VIN</label><input type="text" value={vVin} onChange={(e) => setVVin(e.target.value.toUpperCase())} className="input-field" placeholder="Optional" /></div>
              {addVehicleMutation.isError && <p className="text-xs text-red-600">{addVehicleMutation.error instanceof Error ? addVehicleMutation.error.message : 'Failed to add vehicle'}</p>}
              <button onClick={() => addVehicleMutation.mutate()} disabled={!vPlate.trim() || addVehicleMutation.isPending} className="btn-primary text-xs">
                {addVehicleMutation.isPending ? 'Adding...' : 'Add Vehicle'}
              </button>
            </div>
          )}

          {customer.vehicles.length === 0 && !showAddVehicle ? (
            <p className="text-sm text-slate-500">No vehicles registered.</p>
          ) : (
            <div className="space-y-3">
              {customer.vehicles.map((v) => (
                <Link key={v.id} href={`/vehicles/${v.id}`} className="block border border-slate-200 rounded-lg p-4 hover:border-blue-300 hover:bg-blue-50/30 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="badge bg-blue-50 text-blue-700 font-mono" title="Service Centre ID">{v.vehicleCode || `SC${v.plateNumber}`}</span>
                      <span className="text-sm font-medium text-slate-900">{[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Unknown vehicle'}</span>
                    </div>
                    {v.weightClass && <span className="badge bg-slate-100 text-slate-600">{v.weightClass}</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                    <span>Plate: <span className="font-medium text-slate-700">{v.plateNumber}</span></span>
                    {v.vin && <span>Chassis Number/VIN: <span className="font-medium text-slate-700">{v.vin}</span></span>}
                    {v.odometer != null && <span>Odometer: <span className="font-medium text-slate-700">{v.odometer.toLocaleString()} mi</span></span>}
                    {v.color && <span>Color: <span className="font-medium text-slate-700">{v.color}</span></span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Visit / Service History */}
      <div className="card mb-6">
        <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Visit &amp; Service History</h2></div>
        <div className="card-body">
          {customer.recentVisits.length === 0 ? (
            <p className="text-sm text-slate-500">No visits on record.</p>
          ) : (
            <div className="table-container border-0 shadow-none">
              <table className="w-full text-sm">
                <thead className="table-header"><tr><th>Date</th><th>Source</th><th>Status</th></tr></thead>
                <tbody>
                  {customer.recentVisits.map((v) => (
                    <tr key={v.id} className="table-row">
                      <td className="text-slate-700">{fmtDate(v.visitedAt)}</td>
                      <td className="text-xs text-slate-500">{v.sourceType.replace(/_/g, ' ')}</td>
                      <td><StatusBadge status={v.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Import Metadata — admin/manager only (backend returns importMeta only for them) */}
      {customer.importMeta && (
        <details className="card mb-6">
          <summary className="card-header cursor-pointer text-sm font-semibold text-slate-700 select-none">Import Metadata (admin)</summary>
          <div className="card-body text-xs text-slate-600 space-y-1">
            <div>Import batch: <span className="font-mono">{customer.importMeta.batchId}</span></div>
            <div>Raw source name: <span className="font-mono">{customer.importMeta.rawName}</span></div>
            <p className="text-slate-400 pt-1">Source-system metadata, hidden from customer-facing notes.</p>
          </div>
        </details>
      )}

      {/* Quick Actions — booking always available; check-in only when there is a
          CONFIRMED appointment for this customer today (check-in is per-appointment). */}
      <div className="flex items-center gap-3">
        <Link href={`/appointments/new?customerId=${customer.id}`} className="btn-primary">Schedule Appointment</Link>
        {hasCheckinableToday && (
          <Link href="/check-in" className="btn-secondary">Check In Today&apos;s Appointment</Link>
        )}
      </div>
    </div>
  );
}
