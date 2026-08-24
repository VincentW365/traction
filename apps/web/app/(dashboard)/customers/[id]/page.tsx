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
import { CustomerNotificationComposer } from '../../../../components/notification-composer';
import { CommunicationHistory } from '../../../../components/communication-history';
import { VisitHistory } from '../../../../components/visit-history';

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
  phoneRaw: string | null;
  email: string | null;
  hasLoyalty: boolean;
  notificationOptInSms: boolean;
  notificationOptInEmail: boolean;
  staffNotes: string | null;
  vehicleCount: number;
  vehicles: Vehicle[];
  recentVisits: RecentVisit[];
  createdAt: string;
  importMeta?: { batchId: string; rawName: string } | null;
  // CR-2026-097 — Customer 360 summary
  stats?: {
    totalVehicles: number;
    totalVisits: number;
    lastVisitAt: string | null;
    nextAppointment: { id: string; scheduledStartAt: string } | null;
  };
  vehicleStats?: Record<string, { visitsCount: number; lastServiceAt: string | null }>;
}

// CR-2026-030: full paginated service history (derived from ServiceVisit).
interface ServiceHistoryItem {
  id: string;
  visitedAt: string | null;
  status: string;
  sourceType: string;
  mileageIn: number | null;
  mileageOut: number | null;
  vehicle: { id: string; vehicleCode: string; plateNumber: string; label: string | null } | null;
  services: string[];
}
interface ServiceHistoryResponse {
  items: ServiceHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

// CR-2026-081: per-customer inspection archive.
interface CustomerInspectionRow {
  id: string;
  inspectionNumber: string;
  status: string;
  inspectionDate: string;
  signedOffAt: string | null;
  findings: { immediate: number; future: number; total: number };
  vehicle: { id: string; plateNumber: string } | null;
}
interface CustomerInspectionResponse {
  items: CustomerInspectionRow[];
  total: number;
  take: number;
  skip: number;
}

const HISTORY_PAGE = 10;
const INSPECTIONS_PAGE = 5;

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtMileage(inM: number | null, outM: number | null): string {
  if (inM == null && outM == null) return '—';
  if (inM != null && outM != null) return `${inM.toLocaleString()} → ${outM.toLocaleString()}`;
  return (outM ?? inM)!.toLocaleString();
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
  const [showComposer, setShowComposer] = useState(false);
  const [vPlate, setVPlate] = useState('');
  const [vVin, setVVin] = useState('');
  const [vMake, setVMake] = useState('');
  const [vModel, setVModel] = useState('');
  const [vYear, setVYear] = useState('');
  const [vColor, setVColor] = useState('');
  const [vOdometer, setVOdometer] = useState('');

  const [editingLoyalty, setEditingLoyalty] = useState(false);
  const [loyaltyMemberInput, setLoyaltyMemberInput] = useState(false);
  const [inspOffset, setInspOffset] = useState(0);
  // CR-2026-097 — vehicle filter for the shared Service History component;
  // set by the vehicle cards' "History" action.
  const [historyVehicleId, setHistoryVehicleId] = useState<string | null>(null);

  // Inline edit state for the identity, contact, and consent cards. Each card
  // edits a 1:1 subset of Customer fields via the shared PATCH /customers/:id.
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [firstNameInput, setFirstNameInput] = useState('');
  const [lastNameInput, setLastNameInput] = useState('');

  const [editingContact, setEditingContact] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [emailInput, setEmailInput] = useState('');

  const [editingConsent, setEditingConsent] = useState(false);
  const [smsOptInInput, setSmsOptInInput] = useState(true);
  const [emailOptInInput, setEmailOptInInput] = useState(true);

  const [editingNotes, setEditingNotes] = useState(false);
  const [notesInput, setNotesInput] = useState('');

  const { data: customer, isLoading, error } = useQuery<CustomerDetail>({
    queryKey: ['customer', customerId],
    queryFn: () => api.get(`/customers/${customerId}`),
    enabled: !!customerId,
  });

  // Check-in is an appointment action: only offer it when this customer has an
  // active appointment scheduled for today at this site. Fails closed (the button
  // stays hidden) if the lookup errors or returns nothing. CR-2026-070 — RESCHEDULED
  // (and DRAFT) appointments are still checkable-in, matching the check-in page.
  const siteId = useSiteId();
  const today = new Date().toISOString().split('T')[0];
  const checkinableQuery = useQuery<Array<{ id: string; status: string; customer: { id: string } | null }>>({
    queryKey: ['customer-checkinable', customerId, siteId, today],
    queryFn: () => api.get(`/appointments?siteId=${siteId}&date=${today}`),
    enabled: !!customerId && !!siteId,
  });
  const hasCheckinableToday = (checkinableQuery.data ?? []).some(
    (a) => a.customer?.id === customerId && ['CONFIRMED', 'DRAFT', 'RESCHEDULED'].includes(a.status),
  );

  // CR-2026-081: per-customer inspection archive (paginated, newest first).
  const inspectionsQuery = useQuery<CustomerInspectionResponse>({
    queryKey: ['customer-inspections', customerId, siteId, inspOffset],
    queryFn: () =>
      api.get(`/inspections?siteId=${siteId}&customerId=${customerId}&take=${INSPECTIONS_PAGE}&skip=${inspOffset}`),
    staleTime: 30000, // inspection records are fresh for 30s
    enabled: !!customerId && !!siteId,
  });

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

  // Edit loyalty membership (yes/no). Modification of a non-sandbox customer is
  // blocked server-side while in Dev Sandbox Mode.
  const updateLoyaltyMutation = useMutation({
    mutationFn: () => api.patch(`/customers/${customerId}`, { loyaltyMember: loyaltyMemberInput }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setEditingLoyalty(false);
    },
  });

  // Generic detail editor — patches whichever fields a card submits, then closes
  // that card's edit mode. Server-side guards (RBAC + sandbox) still apply.
  const updateIdentityMutation = useMutation({
    mutationFn: () =>
      api.patch(`/customers/${customerId}`, {
        firstName: firstNameInput.trim(),
        lastName: lastNameInput.trim(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setEditingIdentity(false);
    },
  });

  const updateContactMutation = useMutation({
    mutationFn: () =>
      api.patch(`/customers/${customerId}`, {
        phone: phoneInput.trim(),
        // Send null-clearing as empty string omitted: only patch email when set,
        // else explicitly clear it.
        email: emailInput.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setEditingContact(false);
    },
  });

  const updateConsentMutation = useMutation({
    mutationFn: () =>
      api.patch(`/customers/${customerId}`, {
        notificationOptInSms: smsOptInInput,
        notificationOptInEmail: emailOptInInput,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setEditingConsent(false);
    },
  });

  const updateNotesMutation = useMutation({
    mutationFn: () => api.patch(`/customers/${customerId}`, { notes: notesInput }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setEditingNotes(false);
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
            <button onClick={() => setShowComposer(true)} className="btn-primary text-sm">Contact Customer</button>
          </div>
        }
      />

      {/* CR-2026-097 — Customer 360 summary strip */}
      {customer.stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <div className="card px-4 py-3">
            <p className="text-xl font-bold text-slate-900">{customer.stats.totalVehicles}</p>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Vehicles</p>
          </div>
          <div className="card px-4 py-3">
            <p className="text-xl font-bold text-slate-900">{customer.stats.totalVisits}</p>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Visits</p>
          </div>
          <div className="card px-4 py-3">
            <p className="text-sm font-semibold text-slate-900 mt-1">{fmtDate(customer.stats.lastVisitAt)}</p>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Last visit</p>
          </div>
          <div className="card px-4 py-3">
            <p className="text-sm font-semibold text-slate-900 mt-1">
              {customer.stats.nextAppointment ? fmtDate(customer.stats.nextAppointment.scheduledStartAt) : '—'}
            </p>
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Next appointment</p>
          </div>
        </div>
      )}

      {/* Identity + key cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Customer Identity */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Customer Identity</h2>
            {!editingIdentity && (
              <button
                onClick={() => { setFirstNameInput(customer.firstName); setLastNameInput(customer.lastName); setEditingIdentity(true); }}
                className="text-xs text-blue-600 hover:underline font-medium"
              >
                Edit
              </button>
            )}
          </div>
          {editingIdentity ? (
            <div className="card-body space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="input-label">First Name</label><input type="text" value={firstNameInput} onChange={(e) => setFirstNameInput(e.target.value)} className="input-field" /></div>
                <div><label className="input-label">Last Name</label><input type="text" value={lastNameInput} onChange={(e) => setLastNameInput(e.target.value)} className="input-field" /></div>
              </div>
              {updateIdentityMutation.isError && (
                <p className="text-xs text-red-600">{updateIdentityMutation.error instanceof Error ? updateIdentityMutation.error.message : 'Failed to update name'}</p>
              )}
              <div className="flex items-center gap-2">
                <button onClick={() => updateIdentityMutation.mutate()} disabled={!firstNameInput.trim() || !lastNameInput.trim() || updateIdentityMutation.isPending} className="btn-primary text-xs">
                  {updateIdentityMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditingIdentity(false)} disabled={updateIdentityMutation.isPending} className="btn-secondary text-xs">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="card-body flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-semibold">{initials || '?'}</div>
              <div>
                <p className="text-base font-semibold text-slate-900">{fullName}</p>
                <p className="text-xs text-slate-500">Customer since {fmtDate(customer.createdAt)}</p>
              </div>
            </div>
          )}
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
          <div className="card-header flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Contact Details</h2>
            {!editingContact && (
              <button
                onClick={() => { setPhoneInput(customer.phoneRaw ?? ''); setEmailInput(customer.email ?? ''); setEditingContact(true); }}
                className="text-xs text-blue-600 hover:underline font-medium"
              >
                Edit
              </button>
            )}
          </div>
          {editingContact ? (
            <div className="card-body space-y-3">
              <div>
                <label className="input-label">Phone</label>
                <input type="tel" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} className="input-field" placeholder="e.g., 876-555-0100" />
                <p className="text-xs text-slate-400 mt-1">Multiple numbers can be entered together; the display splits them automatically.</p>
              </div>
              <div>
                <label className="input-label">Email</label>
                <input type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} className="input-field" placeholder="Optional" />
              </div>
              {updateContactMutation.isError && (
                <p className="text-xs text-red-600">{updateContactMutation.error instanceof Error ? updateContactMutation.error.message : 'Failed to update contact'}</p>
              )}
              <div className="flex items-center gap-2">
                <button onClick={() => updateContactMutation.mutate()} disabled={!phoneInput.trim() || updateContactMutation.isPending} className="btn-primary text-xs">
                  {updateContactMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditingContact(false)} disabled={updateContactMutation.isPending} className="btn-secondary text-xs">Cancel</button>
              </div>
            </div>
          ) : (
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
          )}
        </div>

        {/* Loyalty Status */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Loyalty Status</h2>
            {!editingLoyalty && (
              <button
                onClick={() => { setLoyaltyMemberInput(customer.hasLoyalty); setEditingLoyalty(true); }}
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
                  <label className="input-label">Loyalty Member</label>
                  <select
                    value={loyaltyMemberInput ? 'yes' : 'no'}
                    onChange={(e) => setLoyaltyMemberInput(e.target.value === 'yes')}
                    className="input-field"
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
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
              </>
            )}
          </div>
        </div>

        {/* Notification Consent */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Preferences &amp; Consent</h2>
            {!editingConsent && (
              <button
                onClick={() => { setSmsOptInInput(customer.notificationOptInSms); setEmailOptInInput(customer.notificationOptInEmail); setEditingConsent(true); }}
                className="text-xs text-blue-600 hover:underline font-medium"
              >
                Edit
              </button>
            )}
          </div>
          {editingConsent ? (
            <div className="card-body space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="input-label">SMS Notifications</label>
                  <select value={smsOptInInput ? 'yes' : 'no'} onChange={(e) => setSmsOptInInput(e.target.value === 'yes')} className="input-field">
                    <option value="yes">Opted in</option>
                    <option value="no">Opted out</option>
                  </select>
                </div>
                <div>
                  <label className="input-label">Email Notifications</label>
                  <select value={emailOptInInput ? 'yes' : 'no'} onChange={(e) => setEmailOptInInput(e.target.value === 'yes')} className="input-field">
                    <option value="yes">Opted in</option>
                    <option value="no">Opted out</option>
                  </select>
                </div>
              </div>
              {updateConsentMutation.isError && (
                <p className="text-xs text-red-600">{updateConsentMutation.error instanceof Error ? updateConsentMutation.error.message : 'Failed to update preferences'}</p>
              )}
              <div className="flex items-center gap-2">
                <button onClick={() => updateConsentMutation.mutate()} disabled={updateConsentMutation.isPending} className="btn-primary text-xs">
                  {updateConsentMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditingConsent(false)} disabled={updateConsentMutation.isPending} className="btn-secondary text-xs">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="card-body grid grid-cols-2 gap-x-6 gap-y-3">
              <div><div className="input-label">SMS Notifications</div><ConsentBadge on={customer.notificationOptInSms} /></div>
              <div><div className="input-label">Email Notifications</div><ConsentBadge on={customer.notificationOptInEmail} /></div>
            </div>
          )}
        </div>

        {/* Notes — staff notes only (import metadata is preserved server-side, never shown/edited here) */}
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Notes</h2>
            {!editingNotes && (
              <button
                onClick={() => { setNotesInput(customer.staffNotes ?? ''); setEditingNotes(true); }}
                className="text-xs text-blue-600 hover:underline font-medium"
              >
                Edit
              </button>
            )}
          </div>
          <div className="card-body">
            {editingNotes ? (
              <div className="space-y-3">
                <textarea
                  value={notesInput}
                  onChange={(e) => setNotesInput(e.target.value)}
                  rows={4}
                  className="input-field"
                  placeholder="Staff notes about this customer (visible to staff only)"
                />
                {updateNotesMutation.isError && (
                  <p className="text-xs text-red-600">{updateNotesMutation.error instanceof Error ? updateNotesMutation.error.message : 'Failed to update notes'}</p>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={() => updateNotesMutation.mutate()} disabled={updateNotesMutation.isPending} className="btn-primary text-xs">
                    {updateNotesMutation.isPending ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={() => setEditingNotes(false)} disabled={updateNotesMutation.isPending} className="btn-secondary text-xs">Cancel</button>
                </div>
              </div>
            ) : customer.staffNotes ? (
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
              {customer.vehicles.map((v) => {
                const vs = customer.vehicleStats?.[v.id];
                return (
                  <div key={v.id} className="border border-slate-200 rounded-lg p-4 hover:border-blue-300 transition-colors">
                    <div className="flex items-center justify-between">
                      <Link href={`/vehicles/${v.id}`} className="flex items-center gap-3 group">
                        <span className="badge bg-blue-50 text-blue-700 font-mono" title="Service Centre ID">{v.vehicleCode || `SC${v.plateNumber}`}</span>
                        <span className="text-sm font-medium text-slate-900 group-hover:text-blue-700">{[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Unknown vehicle'}</span>
                      </Link>
                      <div className="flex items-center gap-2">
                        {v.weightClass && <span className="badge bg-slate-100 text-slate-600">{v.weightClass}</span>}
                        <button
                          onClick={() => {
                            setHistoryVehicleId(historyVehicleId === v.id ? null : v.id);
                            document.getElementById('service-history')?.scrollIntoView({ behavior: 'smooth' });
                          }}
                          className={`text-xs px-2 py-0.5 rounded-md border ${historyVehicleId === v.id ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 text-blue-600 hover:border-blue-300'}`}
                        >
                          History
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                      <span>Plate: <span className="font-medium text-slate-700">{v.plateNumber}</span></span>
                      {v.vin && <span>Chassis Number/VIN: <span className="font-medium text-slate-700">{v.vin}</span></span>}
                      {v.odometer != null && <span>Odometer: <span className="font-medium text-slate-700">{v.odometer.toLocaleString()} mi</span></span>}
                      {v.color && <span>Color: <span className="font-medium text-slate-700">{v.color}</span></span>}
                      {/* CR-2026-097 — per-vehicle history at a glance */}
                      {vs && (
                        <span>
                          Visits: <span className="font-medium text-slate-700">{vs.visitsCount}</span>
                          {vs.lastServiceAt && <> · Last service: <span className="font-medium text-slate-700">{fmtDate(vs.lastServiceAt)}</span></>}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* CR-2026-097 — shared Service History (every row opens the full Visit Record) */}
      <div id="service-history" className="mb-6">
        <VisitHistory
          customerId={customer.id}
          vehicles={customer.vehicles.map((v) => ({
            id: v.id,
            plateNumber: v.plateNumber,
            label: [v.modelYear, v.make, v.model].filter(Boolean).join(' ') || null,
          }))}
          selectedVehicleId={historyVehicleId}
          onVehicleChange={setHistoryVehicleId}
        />
      </div>

      {/* Inspections — CR-2026-081: per-customer inspection archive with date & findings */}
      <div className="card mb-6">
        <div className="card-header flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Inspections</h2>
          {inspectionsQuery.data && inspectionsQuery.data.total > 0 && (
            <span className="text-xs text-slate-500">
              {inspectionsQuery.data.skip + 1}–
              {Math.min(inspectionsQuery.data.skip + inspectionsQuery.data.items.length, inspectionsQuery.data.total)} of{' '}
              {inspectionsQuery.data.total}
            </span>
          )}
        </div>
        <div className="card-body">
          {inspectionsQuery.isLoading ? (
            <p className="text-sm text-slate-500">Loading inspections…</p>
          ) : inspectionsQuery.isError ? (
            <p className="text-sm text-red-600">Failed to load inspections.</p>
          ) : !inspectionsQuery.data || inspectionsQuery.data.items.length === 0 ? (
            <p className="text-sm text-slate-500">No inspections on record.</p>
          ) : (
            <>
              <div className="table-container border-0 shadow-none">
                <table className="w-full text-sm">
                  <thead className="table-header">
                    <tr><th>Date</th><th>Inspection #</th><th>Vehicle</th><th>Status</th><th>Findings</th><th>Sign-off</th></tr>
                  </thead>
                  <tbody>
                    {inspectionsQuery.data.items.map((i) => (
                      <tr key={i.id} className="table-row">
                        <td className="text-slate-700 whitespace-nowrap">{fmtDate(i.inspectionDate)}</td>
                        <td>
                          <Link href={`/inspections/${i.id}`} className="font-mono text-xs font-semibold text-blue-600 hover:underline">
                            {i.inspectionNumber}
                          </Link>
                        </td>
                        <td className="text-slate-600 font-mono text-xs">{i.vehicle?.plateNumber ?? '—'}</td>
                        <td><StatusBadge status={i.status} /></td>
                        <td className="whitespace-nowrap">
                          {i.findings.total === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              {i.findings.immediate > 0 && <span className="badge bg-red-50 text-red-700">{i.findings.immediate} immediate</span>}
                              {i.findings.future > 0 && <span className="badge bg-amber-50 text-amber-700">{i.findings.future} future</span>}
                            </span>
                          )}
                        </td>
                        <td>
                          {i.signedOffAt
                            ? <span className="badge bg-emerald-50 text-emerald-700">Signed off</span>
                            : <span className="text-xs text-slate-400">Pending</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {inspectionsQuery.data.total > INSPECTIONS_PAGE && (
                <div className="flex items-center justify-between pt-3 mt-1 border-t border-slate-100">
                  <button
                    onClick={() => setInspOffset(Math.max(inspOffset - INSPECTIONS_PAGE, 0))}
                    disabled={inspOffset === 0}
                    className="btn-secondary text-xs disabled:opacity-50"
                  >Previous</button>
                  <button
                    onClick={() => setInspOffset(inspOffset + INSPECTIONS_PAGE)}
                    disabled={inspOffset + INSPECTIONS_PAGE >= inspectionsQuery.data.total}
                    className="btn-secondary text-xs disabled:opacity-50"
                  >Next</button>
                </div>
              )}
            </>
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

      {/* CR-2026-096 — every message this customer has been sent, with delivery state */}
      <div className="mb-6">
        <CommunicationHistory customerId={customer.id} />
      </div>

      {/* Quick Actions — booking always available; check-in only when there is a
          CONFIRMED appointment for this customer today (check-in is per-appointment). */}
      <div className="flex items-center gap-3">
        <Link href={`/appointments/new?customerId=${customer.id}`} className="btn-primary">Schedule Appointment</Link>
        {hasCheckinableToday && (
          <Link href="/check-in" className="btn-secondary">Check In Today&apos;s Appointment</Link>
        )}
      </div>

      {showComposer && (
        <CustomerNotificationComposer
          open
          context={{ reason: 'CUSTOM', customerId: customer.id, vehicleId: customer.vehicles?.[0]?.id }}
          onClose={() => setShowComposer(false)}
        />
      )}
    </div>
  );
}
