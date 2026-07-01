'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { StatusBadge } from '../../../components/status-badge';
import { PageHeader } from '../../../components/ui/page-header';
import { useSiteId } from '../../../hooks/use-site';

/* ---------- Types (matching actual API response shapes) ---------- */

interface Vehicle {
  id: string;
  plateNumber: string;
  make: string | null;
  model: string | null;
  modelYear: number | null;
}

interface CustomerSearchResult {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
}

interface CustomerDetail extends CustomerSearchResult {
  vehicles: Vehicle[];
  notificationOptInSms?: boolean;
  notificationOptInEmail?: boolean;
}

interface AppointmentResult {
  id: string;
  scheduledStartAt: string;
  status: string;
  services: Array<{ serviceType: { name: string; code: string } }>;
}

interface ServiceType {
  id: string;
  code: string;
  name: string;
  family: string;
  baseDurationMinutes: number;
  partsPrepositionRequired?: boolean;
}

interface CheckInResponse {
  serviceVisit: { id: string; status: string };
  queueTicket: { ticketNumber: string; displayStatus: string };
  priorityClass: string;
  etaStartAt: string | null;
  customerStatusUrl?: string;
}

/* ---------- Component ---------- */

export default function CheckInPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetail | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [showWalkInForm, setShowWalkInForm] = useState(false);
  const [selectedServiceCodes, setSelectedServiceCodes] = useState<string[]>([]);
  const [serviceSearch, setServiceSearch] = useState('');
  // v4.1 intake fields
  const [mileageIn, setMileageIn] = useState('');
  const [oilBrand, setOilBrand] = useState('');
  const [oilBrandOther, setOilBrandOther] = useState('');
  const [oilGrade, setOilGrade] = useState('');
  const [oilGradeOther, setOilGradeOther] = useState('');
  const [vehicleWeightClass, setVehicleWeightClass] = useState('STANDARD');
  const [vehicleColor, setVehicleColor] = useState('');
  // P4(b) notification consent capture (default opt-out unless explicitly set)
  const [notifyOptInSms, setNotifyOptInSms] = useState(false);
  const [notifyOptInEmail, setNotifyOptInEmail] = useState(false);
  const [successResult, setSuccessResult] = useState<{
    ticketNumber: string;
    priorityClass: string;
    etaStartAt: string | null;
    customerStatusUrl: string | null;
    type: 'check-in' | 'walk-in';
  } | null>(null);

  // Debounced search
  useEffect(() => {
    if (searchTerm.length < 2) { setDebouncedTerm(''); return; }
    const timer = setTimeout(() => setDebouncedTerm(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Search customers
  const customersQuery = useQuery({
    queryKey: ['customers-search', debouncedTerm],
    queryFn: () => api.get<CustomerSearchResult[]>(`/customers?q=${encodeURIComponent(debouncedTerm)}`),
    enabled: debouncedTerm.length >= 2,
  });

  // Load customer detail (with vehicles) when selected
  const customerDetailQuery = useQuery({
    queryKey: ['customer-detail', selectedCustomer?.id],
    queryFn: () => api.get<CustomerDetail>(`/customers/${selectedCustomer!.id}`),
    enabled: !!selectedCustomer?.id,
  });

  // P4(b): seed the consent checkboxes from the customer's current values so we
  // preserve existing consent and never silently flip it; default opt-out.
  useEffect(() => {
    const c = customerDetailQuery.data;
    setNotifyOptInSms(c?.notificationOptInSms ?? false);
    setNotifyOptInEmail(c?.notificationOptInEmail ?? false);
  }, [customerDetailQuery.data]);

  // Load today's appointments for selected customer at this site
  const today = new Date().toISOString().split('T')[0];
  const appointmentsQuery = useQuery({
    queryKey: ['appointments', siteId, today, selectedCustomer?.id],
    queryFn: () => api.get<AppointmentResult[]>(`/appointments?siteId=${siteId}&date=${today}`),
    enabled: !!selectedCustomer && !!selectedVehicle,
    select: (data) => data.filter((a) =>
      ['CONFIRMED', 'DRAFT'].includes(a.status)
    ),
  });

  // Service types for walk-in
  const serviceQuery = serviceSearch.trim().toLowerCase();
  const serviceTypesQuery = useQuery({
    queryKey: ['service-types'],
    queryFn: () => api.get<ServiceType[]>('/service-types'),
    enabled: showWalkInForm,
  });
  // Searchable walk-in services — match name, family, or code (selections persist).
  const filteredServices = (serviceTypesQuery.data ?? []).filter((st) =>
    !serviceQuery ||
    st.name.toLowerCase().includes(serviceQuery) ||
    (st.family ?? '').toLowerCase().includes(serviceQuery) ||
    st.code.toLowerCase().includes(serviceQuery),
  );

  // Check-in mutation
  const checkInMutation = useMutation({
    mutationFn: (appointmentId: string) =>
      api.post<CheckInResponse>(`/appointments/${appointmentId}/check-in`, {
        mileageIn: mileageIn ? parseInt(mileageIn, 10) : undefined,
        oilBrand: (oilBrand === 'Other' ? (oilBrandOther.trim() || 'Other') : oilBrand) || undefined,
        oilGrade: (oilGrade === 'Other' ? (oilGradeOther.trim() || 'Other') : oilGrade) || undefined,
        vehicleWeightClass: vehicleWeightClass || undefined,
        color: vehicleColor || undefined,
        notificationOptInSms: notifyOptInSms,
        notificationOptInEmail: notifyOptInEmail,
      }),
    onSuccess: (data) => {
      setSuccessResult({
        ticketNumber: data.queueTicket.ticketNumber,
        priorityClass: data.priorityClass,
        etaStartAt: data.etaStartAt,
        customerStatusUrl: data.customerStatusUrl ?? null,
        type: 'check-in',
      });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
  });

  // Walk-in mutation
  const walkInMutation = useMutation({
    mutationFn: (payload: {
      siteId: string;
      customerId: string;
      vehicleId: string;
      serviceTypes: Array<{ serviceTypeCode: string }>;
      mileageIn?: number;
      oilBrand?: string;
      oilGrade?: string;
      vehicleWeightClass?: string;
      color?: string;
    }) => api.post<CheckInResponse>('/walk-ins', payload),
    onSuccess: (data) => {
      setSuccessResult({
        ticketNumber: data.queueTicket.ticketNumber,
        priorityClass: data.priorityClass,
        etaStartAt: data.etaStartAt,
        customerStatusUrl: data.customerStatusUrl ?? null,
        type: 'walk-in',
      });
      setShowWalkInForm(false);
      setSelectedServiceCodes([]);
    },
  });

  // Auto-select vehicle when detail loads
  useEffect(() => {
    if (customerDetailQuery.data?.vehicles?.length === 1) {
      setSelectedVehicle(customerDetailQuery.data.vehicles[0]);
    }
  }, [customerDetailQuery.data]);

  function handleSelectCustomer(c: CustomerSearchResult) {
    setSelectedCustomer(c as CustomerDetail);
    setSelectedVehicle(null);
  }

  function handleReset() {
    setSuccessResult(null);
    setSelectedCustomer(null);
    setSelectedVehicle(null);
    setSearchTerm('');
    setDebouncedTerm('');
    setShowWalkInForm(false);
    setSelectedServiceCodes([]);
    setServiceSearch('');
    setMileageIn('');
    setOilBrand('');
    setOilBrandOther('');
    setOilGrade('');
    setOilGradeOther('');
    setVehicleWeightClass('STANDARD');
    setVehicleColor('');
  }

  function handleWalkInSubmit() {
    if (!selectedCustomer || !selectedVehicle || selectedServiceCodes.length === 0) return;
    walkInMutation.mutate({
      siteId: siteId,
      customerId: selectedCustomer.id,
      vehicleId: selectedVehicle.id,
      serviceTypes: selectedServiceCodes.map((code) => ({ serviceTypeCode: code })),
      mileageIn: mileageIn ? parseInt(mileageIn, 10) : undefined,
      oilBrand: (oilBrand === 'Other' ? (oilBrandOther.trim() || 'Other') : oilBrand) || undefined,
      oilGrade: (oilGrade === 'Other' ? (oilGradeOther.trim() || 'Other') : oilGrade) || undefined,
      vehicleWeightClass: vehicleWeightClass || undefined,
      color: vehicleColor || undefined,
    });
  }

  const vehicles = customerDetailQuery.data?.vehicles ?? [];

  /* ---------- Render: Success ---------- */
  if (successResult) {
    return (
      <div className="page-container max-w-lg mx-auto">
        <div className="card p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-1">
            {successResult.type === 'check-in' ? 'Checked In' : 'Walk-In Registered'}
          </h2>
          <div className="mt-6 space-y-3">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Ticket Number</p>
              <p className="text-2xl font-mono font-bold text-slate-900 mt-0.5">{successResult.ticketNumber}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Priority</p>
              <div className="mt-1"><StatusBadge status={successResult.priorityClass} /></div>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Estimated Start</p>
              <p className="text-lg font-semibold text-slate-900 mt-0.5">
                {successResult.etaStartAt
                  ? new Date(successResult.etaStartAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                  : 'Pending'}
              </p>
            </div>
          </div>
          {successResult.customerStatusUrl && (
            <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
              <p className="text-xs text-blue-600 uppercase tracking-wider mb-1">Customer Status Link</p>
              <p className="text-sm font-mono text-blue-800 break-all">
                {window.location.origin}{successResult.customerStatusUrl}
              </p>
              <p className="text-xs text-blue-500 mt-1">Share this link with the customer to track their visit status.</p>
            </div>
          )}
          <button onClick={handleReset}
            className="mt-8 w-full btn-primary px-4 py-3 text-sm font-semibold">
            Next Customer
          </button>
        </div>
      </div>
    );
  }

  /* ---------- Render: Main ---------- */
  return (
    <div className="page-container max-w-4xl">
      <PageHeader
        title="Check-In"
        subtitle="Process arrivals and walk-ins"
        breadcrumbs={[
          { label: 'Dashboard', href: '/' },
          { label: 'Check-In' },
        ]}
      />

      {/* Search */}
      <div className="relative mb-6">
        <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input type="text" placeholder="Search by phone, plate, or name..."
          value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
          className="input-field pl-11 pr-4 py-3" />
      </div>

      {/* Search results */}
      {debouncedTerm.length >= 2 && !selectedCustomer && (
        <div className="card mb-6">
          <div className="px-4 py-3 border-b">
            <h2 className="text-sm font-semibold text-slate-700">Search Results</h2>
          </div>
          {customersQuery.isLoading && <div className="p-6 text-center text-sm text-slate-500">Searching...</div>}
          {customersQuery.data?.length === 0 && (
            <div className="p-6 text-center">
              <p className="text-sm text-slate-500">No customers found</p>
              <a href="/customers" className="text-xs text-blue-600 hover:underline mt-2 inline-block">Create New Customer</a>
            </div>
          )}
          {customersQuery.data && customersQuery.data.length > 0 && (
            <ul className="divide-y">
              {customersQuery.data.map((c) => (
                <li key={c.id}>
                  <button onClick={() => handleSelectCustomer(c)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors">
                    <p className="text-sm font-medium text-slate-900">{c.firstName} {c.lastName}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{c.phone} &middot; {c.customerNumber}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Selected customer */}
      {selectedCustomer && (
        <div className="space-y-4">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  {selectedCustomer.firstName} {selectedCustomer.lastName}
                </h2>
                <p className="text-sm text-slate-500">{selectedCustomer.phone} &middot; {selectedCustomer.customerNumber}</p>
              </div>
              <button onClick={handleReset} className="text-sm text-slate-500 hover:text-slate-700 underline">Change</button>
            </div>

            {/* Vehicle selection */}
            {vehicles.length > 1 && !selectedVehicle && (
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">Select a vehicle:</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {vehicles.map((v) => (
                    <button key={v.id} onClick={() => setSelectedVehicle(v)}
                      className="rounded-lg border border-slate-200 px-4 py-3 text-left hover:border-blue-400 hover:bg-blue-50 transition-colors">
                      <p className="text-sm font-mono font-medium text-slate-900">{v.plateNumber}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Unknown'}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {vehicles.length === 0 && customerDetailQuery.isSuccess && (
              <p className="text-sm text-amber-600">No vehicles on file. Add a vehicle first.</p>
            )}

            {selectedVehicle && (
              <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-sm font-mono font-medium text-slate-900">{selectedVehicle.plateNumber}</span>
                <span className="text-xs text-slate-500">
                  {[selectedVehicle.modelYear, selectedVehicle.make, selectedVehicle.model].filter(Boolean).join(' ')}
                </span>
              </div>
            )}
          </div>

          {/* Today's appointments */}
          {selectedVehicle && appointmentsQuery.data && appointmentsQuery.data.length > 0 && (
            <div className="card">
              <div className="px-4 py-3 border-b">
                <h3 className="text-sm font-semibold text-slate-700">Today&apos;s Appointments</h3>
              </div>
              <ul className="divide-y">
                {appointmentsQuery.data.map((appt) => (
                  <li key={appt.id} className="px-4 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {new Date(appt.scheduledStartAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        {' — '}
                        {appt.services.map((s) => s.serviceType.name).join(', ')}
                      </p>
                      <div className="mt-1"><StatusBadge status={appt.status} /></div>
                    </div>
                    {appt.status === 'CONFIRMED' && (
                      <button onClick={() => checkInMutation.mutate(appt.id)}
                        disabled={checkInMutation.isPending}
                        className="btn-success px-6 py-3 text-sm font-bold disabled:opacity-50">
                        {checkInMutation.isPending ? 'Checking in...' : 'Check In'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {checkInMutation.isError && (
                <div className="px-4 py-3 border-t bg-red-50 text-sm text-red-700 rounded-b-xl">
                  {checkInMutation.error instanceof Error ? checkInMutation.error.message : 'Check-in failed'}
                </div>
              )}
            </div>
          )}

          {/* v4.1 Intake Fields (shown when vehicle is selected) */}
          {selectedVehicle && (
            <div className="card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">Intake Details</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="input-label">Mileage In *</label>
                  <input type="number" value={mileageIn} onChange={(e) => setMileageIn(e.target.value)}
                    placeholder="e.g., 45230" min="0"
                    className="input-field" />
                </div>
                <div>
                  <label className="input-label">Vehicle Weight</label>
                  <select value={vehicleWeightClass} onChange={(e) => setVehicleWeightClass(e.target.value)}
                    className="input-field">
                    <option value="LIGHT">Light</option>
                    <option value="STANDARD">Standard</option>
                    <option value="HEAVY">Heavy</option>
                  </select>
                </div>
                <div>
                  <label className="input-label">Oil Brand</label>
                  <select value={oilBrand} onChange={(e) => setOilBrand(e.target.value)}
                    className="input-field">
                    <option value="">-- Select --</option>
                    <option value="Amsoil">Amsoil</option>
                    <option value="Liqui Moly">Liqui Moly</option>
                    <option value="Valvoline">Valvoline</option>
                    <option value="Castrol">Castrol</option>
                    <option value="Mobil 1">Mobil 1</option>
                    <option value="Other">Other</option>
                  </select>
                  {oilBrand === 'Other' && (
                    <input type="text" value={oilBrandOther} onChange={(e) => setOilBrandOther(e.target.value)}
                      placeholder="Type oil brand (optional)" className="input-field mt-2" />
                  )}
                </div>
                <div>
                  <label className="input-label">Oil Grade</label>
                  <select value={oilGrade} onChange={(e) => setOilGrade(e.target.value)}
                    className="input-field">
                    <option value="">-- Select --</option>
                    <option value="0W-20">0W-20</option>
                    <option value="5W-20">5W-20</option>
                    <option value="5W-30">5W-30</option>
                    <option value="10W-30">10W-30</option>
                    <option value="10W-40">10W-40</option>
                    <option value="15W-40">15W-40</option>
                    <option value="0W-40">0W-40</option>
                    <option value="Other">Other</option>
                  </select>
                  {oilGrade === 'Other' && (
                    <input type="text" value={oilGradeOther} onChange={(e) => setOilGradeOther(e.target.value)}
                      placeholder="Type oil grade (optional)" className="input-field mt-2" />
                  )}
                </div>
                <div className="col-span-2">
                  <label className="input-label">Vehicle Color</label>
                  <input type="text" value={vehicleColor} onChange={(e) => setVehicleColor(e.target.value)}
                    placeholder="e.g., Silver, White, Black"
                    className="input-field" />
                </div>
                {/* P4(b): notification consent capture (default opt-out) */}
                <div className="col-span-2 border-t border-slate-100 pt-3 mt-1">
                  <p className="input-label mb-2">Notification consent</p>
                  <div className="space-y-2">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input type="checkbox" checked={notifyOptInSms} onChange={(e) => setNotifyOptInSms(e.target.checked)}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                      <span className="text-sm text-slate-700">Customer consents to SMS updates</span>
                    </label>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input type="checkbox" checked={notifyOptInEmail} onChange={(e) => setNotifyOptInEmail(e.target.checked)}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                      <span className="text-sm text-slate-700">Customer consents to email updates</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Walk-in button */}
          {selectedVehicle && !showWalkInForm && (
            <button onClick={() => setShowWalkInForm(true)}
              className="w-full rounded-xl border-2 border-dashed border-blue-300 bg-blue-50 px-6 py-4 text-sm font-semibold text-blue-700 hover:bg-blue-100 transition-colors">
              + Register Walk-In
            </button>
          )}

          {/* Walk-in form */}
          {selectedVehicle && showWalkInForm && (
            <div className="card">
              <div className="px-4 py-3 border-b flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">Walk-In Service Selection</h3>
                <button onClick={() => { setShowWalkInForm(false); setSelectedServiceCodes([]); setServiceSearch(''); }}
                  className="text-xs text-slate-500 hover:text-slate-700 underline">Cancel</button>
              </div>
              <div className="p-4">
                {serviceTypesQuery.isLoading && <p className="text-sm text-slate-500">Loading services...</p>}
                {serviceTypesQuery.data && (
                  <>
                    <input
                      type="text"
                      value={serviceSearch}
                      onChange={(e) => setServiceSearch(e.target.value)}
                      placeholder="Search services by name, family, or code…"
                      className="input-field mb-3"
                    />
                    <div className="space-y-2 mb-4 max-h-80 overflow-y-auto">
                      {filteredServices.map((st) => (
                        <label key={st.code}
                          className={`flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors ${
                            selectedServiceCodes.includes(st.code) ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                          <input type="checkbox" checked={selectedServiceCodes.includes(st.code)}
                            onChange={() => setSelectedServiceCodes((prev) =>
                              prev.includes(st.code) ? prev.filter((c) => c !== st.code) : [...prev, st.code])}
                            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-slate-900">{st.name}</p>
                            <p className="text-xs text-slate-500">~{st.baseDurationMinutes} min &middot; {st.family}</p>
                          </div>
                        </label>
                      ))}
                      {filteredServices.length === 0 && (
                        <p className="text-sm text-slate-500 text-center py-4">No services match &ldquo;{serviceSearch}&rdquo;.</p>
                      )}
                    </div>
                  </>
                )}
                {(() => {
                  const parts = (serviceTypesQuery.data ?? []).filter(
                    (st) => selectedServiceCodes.includes(st.code) && st.partsPrepositionRequired,
                  );
                  return parts.length > 0 ? (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                      <p className="text-sm font-medium text-amber-800">⚠ May require parts</p>
                      <p className="text-xs text-amber-700 mt-0.5">
                        {parts.map((s) => s.name).join(', ')} may need parts — arrange preposition in the parts system.
                      </p>
                    </div>
                  ) : null;
                })()}
                <button onClick={handleWalkInSubmit}
                  disabled={selectedServiceCodes.length === 0 || walkInMutation.isPending}
                  className="w-full btn-primary px-6 py-3 text-sm font-bold disabled:opacity-50">
                  {walkInMutation.isPending ? 'Registering...' : `Register Walk-In (${selectedServiceCodes.length} service${selectedServiceCodes.length !== 1 ? 's' : ''})`}
                </button>
                {walkInMutation.isError && (
                  <div className="mt-3 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                    {walkInMutation.error instanceof Error ? walkInMutation.error.message : 'Registration failed'}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
