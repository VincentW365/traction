'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';

interface CustomerResult {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
}

interface Vehicle {
  id: string;
  plateNumber: string;
  make: string | null;
  model: string | null;
  modelYear: number | null;
}

interface CustomerDetail {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  vehicles: Vehicle[];
}

interface ServiceType {
  id: string;
  code: string;
  name: string;
  family: string;
  baseDurationMinutes: number;
}

type Step = 'customer' | 'vehicle' | 'services' | 'time' | 'success';

const STEP_META: Record<Exclude<Step, 'success'>, { number: number; label: string }> = {
  customer: { number: 1, label: 'Select Customer' },
  vehicle: { number: 2, label: 'Select Vehicle' },
  services: { number: 3, label: 'Choose Services' },
  time: { number: 4, label: 'Pick Date & Time' },
};

const STEPS: Array<Exclude<Step, 'success'>> = ['customer', 'vehicle', 'services', 'time'];

function StepIndicator({ currentStep }: { currentStep: Step }) {
  if (currentStep === 'success') return null;
  const currentMeta = STEP_META[currentStep];

  return (
    <div className="flex items-center gap-2 mb-6">
      {STEPS.map((s, idx) => {
        const meta = STEP_META[s];
        const isCurrent = s === currentStep;
        const isComplete = meta.number < currentMeta.number;

        return (
          <div key={s} className="flex items-center gap-2">
            {idx > 0 && (
              <div className={`w-8 h-px ${isComplete ? 'bg-blue-400' : 'bg-slate-200'}`} />
            )}
            <div className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  isCurrent
                    ? 'bg-blue-600 text-white'
                    : isComplete
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-slate-100 text-slate-400'
                }`}
              >
                {isComplete ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  meta.number
                )}
              </div>
              <span
                className={`text-xs font-medium hidden sm:block ${
                  isCurrent ? 'text-slate-900' : isComplete ? 'text-blue-600' : 'text-slate-400'
                }`}
              >
                {meta.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function NewAppointmentPage() {
  const siteId = useSiteId();

  // Step tracking
  const [step, setStep] = useState<Step>('customer');

  // Search
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');

  // Selections
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerResult | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [selectedServiceCodes, setSelectedServiceCodes] = useState<string[]>([]);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('09:00');
  const [notes, setNotes] = useState('');

  // Success state
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Debounce search
  useEffect(() => {
    if (searchTerm.length < 2) { setDebouncedTerm(''); return; }
    const timer = setTimeout(() => setDebouncedTerm(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Set default date to tomorrow
  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setScheduledDate(tomorrow.toISOString().split('T')[0]);
  }, []);

  // Queries
  const customersQuery = useQuery({
    queryKey: ['customer-search', debouncedTerm],
    queryFn: () => api.get<CustomerResult[]>(`/customers?q=${encodeURIComponent(debouncedTerm)}`),
    enabled: debouncedTerm.length >= 2,
  });

  const customerDetailQuery = useQuery({
    queryKey: ['customer-detail', selectedCustomer?.id],
    queryFn: () => api.get<CustomerDetail>(`/customers/${selectedCustomer!.id}`),
    enabled: !!selectedCustomer,
  });

  const serviceTypesQuery = useQuery({
    queryKey: ['service-types'],
    queryFn: () => api.get<ServiceType[]>('/service-types'),
  });

  // Auto-advance when customer detail loads
  useEffect(() => {
    if (customerDetailQuery.data && step === 'customer') {
      const vehicles = customerDetailQuery.data.vehicles;
      if (vehicles.length === 1) {
        setSelectedVehicle(vehicles[0]);
        setStep('services');
      } else if (vehicles.length > 1) {
        setStep('vehicle');
      }
    }
  }, [customerDetailQuery.data, step]);

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (payload: {
      siteId: string;
      customerId: string;
      vehicleId: string;
      scheduledStartAt: string;
      serviceTypes: Array<{ serviceTypeCode: string }>;
      notes?: string;
    }) => api.post<{ id: string }>('/appointments', payload),
    onSuccess: (data) => {
      setCreatedId(data.id);
      setStep('success');
    },
  });

  function handleSubmit() {
    if (!selectedCustomer || !selectedVehicle || selectedServiceCodes.length === 0 || !scheduledDate) return;
    const scheduledStartAt = new Date(`${scheduledDate}T${scheduledTime}:00`).toISOString();
    createMutation.mutate({
      siteId: siteId,
      customerId: selectedCustomer.id,
      vehicleId: selectedVehicle.id,
      scheduledStartAt,
      serviceTypes: selectedServiceCodes.map((code) => ({ serviceTypeCode: code })),
      notes: notes || undefined,
    });
  }

  const totalDuration = serviceTypesQuery.data
    ?.filter((st) => selectedServiceCodes.includes(st.code))
    .reduce((sum, st) => sum + st.baseDurationMinutes, 0) ?? 0;

  // --- Success Screen ---
  if (step === 'success') {
    return (
      <div className="page-container max-w-lg mx-auto mt-8">
        <div className="card">
          <div className="card-body py-10 text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-slate-900">Appointment Created</h2>
            <p className="text-sm text-slate-500 mt-2">
              {scheduledDate} at {scheduledTime} for {selectedCustomer?.firstName} {selectedCustomer?.lastName}
            </p>
            <div className="mt-6 flex gap-3 justify-center">
              <a href="/appointments" className="btn-secondary">
                View Appointments
              </a>
              <a href="/appointments/new" className="btn-primary">
                Book Another
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Main Form ---
  return (
    <div className="page-container max-w-2xl">
      <PageHeader
        title="New Appointment"
        breadcrumbs={[
          { label: 'Appointments', href: '/appointments' },
          { label: 'New' },
        ]}
      />

      <StepIndicator currentStep={step} />

      {/* Step 1: Customer Search */}
      {step === 'customer' && (
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Step 1: Select Customer</h2>
          </div>
          <div className="card-body space-y-4">
            <div>
              <label className="input-label">Search</label>
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search by phone, name, or plate..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="input-field pl-9"
                />
              </div>
            </div>

            {customersQuery.data && customersQuery.data.length > 0 && (
              <div className="border border-slate-200 rounded-md overflow-hidden">
                {customersQuery.data.map((c, idx) => (
                  <button
                    key={c.id}
                    onClick={() => { setSelectedCustomer(c); }}
                    className={`w-full text-left px-4 py-3 hover:bg-blue-50 transition-colors ${
                      idx > 0 ? 'border-t border-slate-100' : ''
                    }`}
                  >
                    <p className="text-sm font-medium text-slate-900">{c.firstName} {c.lastName}</p>
                    <p className="text-xs text-slate-500">{c.phone} &middot; {c.customerNumber}</p>
                  </button>
                ))}
              </div>
            )}

            {debouncedTerm.length >= 2 && customersQuery.data?.length === 0 && (
              <p className="text-sm text-slate-500 text-center py-4">No customers found</p>
            )}
          </div>
        </div>
      )}

      {/* Step 2: Vehicle Selection */}
      {step === 'vehicle' && customerDetailQuery.data && (
        <div className="card">
          <div className="card-header">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Step 2: Select Vehicle</h2>
              <span className="text-xs text-slate-500">
                {selectedCustomer?.firstName} {selectedCustomer?.lastName}
              </span>
            </div>
          </div>
          <div className="card-body space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {customerDetailQuery.data.vehicles.map((v) => (
                <button
                  key={v.id}
                  onClick={() => { setSelectedVehicle(v); setStep('services'); }}
                  className="border border-slate-200 rounded-lg px-4 py-4 text-left hover:border-blue-400 hover:bg-blue-50/50 transition-colors"
                >
                  <p className="text-sm font-bold font-mono text-slate-900">{v.plateNumber}</p>
                  <p className="text-xs text-slate-500 mt-1">
                    {[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Unknown vehicle'}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Service Selection */}
      {step === 'services' && (
        <div className="card">
          <div className="card-header">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Step 3: Choose Services</h2>
              <span className="text-xs text-slate-500">
                {selectedCustomer?.firstName} {selectedCustomer?.lastName} &middot; {selectedVehicle?.plateNumber}
              </span>
            </div>
          </div>
          <div className="card-body space-y-4">
            {serviceTypesQuery.data && (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {serviceTypesQuery.data.map((st) => {
                  const isSelected = selectedServiceCodes.includes(st.code);
                  return (
                    <label
                      key={st.code}
                      className={`flex items-center gap-3 rounded-md border px-4 py-3 cursor-pointer transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() =>
                          setSelectedServiceCodes((prev) =>
                            prev.includes(st.code) ? prev.filter((c) => c !== st.code) : [...prev, st.code]
                          )
                        }
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-900">{st.name}</p>
                        <p className="text-xs text-slate-500">~{st.baseDurationMinutes} min &middot; {st.family}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}

            {selectedServiceCodes.length > 0 && (
              <div className="flex items-center justify-between border-t border-slate-100 pt-4">
                <p className="text-sm text-slate-600">
                  {selectedServiceCodes.length} service{selectedServiceCodes.length !== 1 ? 's' : ''} &middot; ~{totalDuration} min total
                </p>
                <button onClick={() => setStep('time')} className="btn-primary">
                  Next: Pick Time
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step 4: Date & Time */}
      {step === 'time' && (
        <div className="space-y-4">
          <div className="card">
            <div className="card-header">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">Step 4: Pick Date & Time</h2>
                <span className="text-xs text-slate-500">
                  {selectedCustomer?.firstName} {selectedCustomer?.lastName} &middot; {selectedVehicle?.plateNumber} &middot; {selectedServiceCodes.length} service{selectedServiceCodes.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
            <div className="card-body space-y-4">
              <div>
                <label className="input-label">Date</label>
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="input-field"
                />
              </div>
              <div>
                <label className="input-label">Time</label>
                <input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  min="08:00"
                  max="17:00"
                  step="900"
                  className="input-field"
                />
              </div>
              <div>
                <label className="input-label">Notes (optional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Any special instructions..."
                  className="input-field"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={() => setStep('services')}
              className="btn-secondary"
            >
              Back to Services
            </button>
            <button
              onClick={handleSubmit}
              disabled={createMutation.isPending || !scheduledDate}
              className="btn-success px-8 py-2.5"
            >
              {createMutation.isPending ? 'Creating...' : 'Create Appointment'}
            </button>
          </div>

          {createMutation.isError && (
            <div className="card border-red-200 bg-red-50">
              <div className="card-body">
                <p className="text-sm text-red-700">
                  {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create appointment'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
