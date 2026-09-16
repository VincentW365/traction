'use client';

/**
 * CR-2026-106 — the staff appointment wizard (docs/121 §C5).
 *
 * Customer → Vehicle → Service request → Date → Available time → Review → Confirm.
 * Every step is reachable backwards (click a step or "Change"); changing the
 * customer resets the vehicle and the chosen time; changing the vehicle keeps the
 * customer. The Date/Time steps show the SAME slots the customer booking page
 * shows, from the same engine (GET /appointments/availability, STAFF audience),
 * so an advisor and a customer can never disagree about what is free. Capacity
 * and the latest-start rule are enforced by the server; the browser only displays
 * them and lets the advisor make an explicit, recorded exception.
 */

import { useEffect, useMemo, useReducer, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { SlotPicker, type Availability } from '../../../book/slot-picker';
import { fmtDayLabel, fmtWhen } from '../../../../lib/public-api';
import {
  INITIAL_WIZARD_STATE,
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  canEnter,
  wizardReducer,
  type WizardCustomer,
  type WizardStep,
  type WizardVehicle,
} from '../../../../lib/appointment-wizard';

interface CustomerDetail {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phones?: string[];
  phone?: string;
  vehicles: WizardVehicle[];
}

interface ServiceType {
  id: string;
  code: string;
  name: string;
  family: string;
  baseDurationMinutes: number;
  partsPrepositionRequired?: boolean;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function StepIndicator({ current, state, onGo }: { current: WizardStep; state: Parameters<typeof canEnter>[0]; onGo: (s: (typeof WIZARD_STEPS)[number]) => void }) {
  if (current === 'success') return null;
  const idx = WIZARD_STEPS.indexOf(current as (typeof WIZARD_STEPS)[number]);
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2" aria-label="Booking steps">
      {WIZARD_STEPS.map((s, i) => {
        const isCurrent = s === current;
        const isComplete = i < idx;
        const reachable = i <= idx || canEnter(state, s);
        return (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <div className={`h-px w-6 ${isComplete ? 'bg-blue-400' : 'bg-slate-200'}`} />}
            <button
              type="button"
              onClick={() => reachable && onGo(s)}
              disabled={!reachable}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex min-h-9 items-center gap-2 rounded-full px-2 py-1 text-xs font-medium transition-colors ${
                isCurrent ? 'bg-blue-600 text-white' : isComplete ? 'bg-blue-50 text-blue-700 hover:bg-blue-100' : reachable ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-slate-50 text-slate-400'
              }`}
            >
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${isCurrent ? 'bg-white text-blue-700' : isComplete ? 'bg-blue-600 text-white' : 'bg-white text-slate-500'}`}>
                {isComplete ? '✓' : i + 1}
              </span>
              <span className="hidden sm:inline">{WIZARD_STEP_LABELS[s]}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Summary({ label, value, onChange }: { label: string; value: string; onChange?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
        <p className="truncate text-sm font-medium text-slate-900">{value}</p>
      </div>
      {onChange && (
        <button type="button" onClick={onChange} className="btn-secondary min-h-9 px-3 py-1 text-xs">
          Change
        </button>
      )}
    </div>
  );
}

export default function NewAppointmentPage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  const [serviceSearch, setServiceSearch] = useState('');
  const [fromKey, setFromKey] = useState<string>(todayKey());
  const [capacityWarning, setCapacityWarning] = useState<{ message: string; capacity?: number; booked?: number } | null>(null);
  const [latestStartWarning, setLatestStartWarning] = useState<string | null>(null);
  const [preferredVehicleId, setPreferredVehicleId] = useState<string | null>(null);

  // Deep links: ?customerId=&vehicleId=&date=&holdId= (from customer/vehicle pages and the schedule).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    const dateKey = p.get('date');
    setPreferredVehicleId(p.get('vehicleId'));
    if (dateKey) setFromKey(dateKey);
    dispatch({ type: 'PREFILL', customerId: p.get('customerId'), vehicleId: p.get('vehicleId'), dateKey, holdId: p.get('holdId') });
  }, []);

  useEffect(() => {
    if (searchTerm.trim().length < 2) {
      setDebouncedTerm('');
      return;
    }
    const t = setTimeout(() => setDebouncedTerm(searchTerm.trim()), 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  const customersQuery = useQuery({
    queryKey: ['customer-search', debouncedTerm],
    queryFn: () => api.get<WizardCustomer[]>(`/customers?q=${encodeURIComponent(debouncedTerm)}`),
    enabled: debouncedTerm.length >= 2,
  });

  const customerDetailQuery = useQuery({
    queryKey: ['customer-detail', state.customer?.id],
    queryFn: () => api.get<CustomerDetail>(`/customers/${state.customer!.id}`),
    enabled: !!state.customer,
  });

  // The ONLY place detail data enters the wizard — the reducer decides what to do with it.
  useEffect(() => {
    const d = customerDetailQuery.data;
    if (!d) return;
    dispatch({
      type: 'CUSTOMER_DETAIL_LOADED',
      customer: { id: d.id, customerNumber: d.customerNumber, firstName: d.firstName, lastName: d.lastName, phone: d.phones?.[0] ?? d.phone ?? '' },
      vehicles: d.vehicles ?? [],
      preferredVehicleId,
    });
  }, [customerDetailQuery.data, preferredVehicleId]);

  const serviceTypesQuery = useQuery({
    queryKey: ['service-types'],
    queryFn: () => api.get<ServiceType[]>('/service-types'),
  });

  const availabilityQuery = useQuery<Availability>({
    queryKey: ['staff-availability', siteId, state.serviceCodes.join(','), fromKey],
    queryFn: () =>
      api.get<Availability>(
        `/appointments/availability?siteId=${encodeURIComponent(siteId)}&serviceCodes=${encodeURIComponent(state.serviceCodes.join(','))}&from=${fromKey}&days=14`,
      ),
    enabled: !!siteId && (state.step === 'date' || state.step === 'time' || state.step === 'review') && state.serviceCodes.length > 0,
    staleTime: 15_000,
  });

  const createMutation = useMutation({
    mutationFn: (payload: {
      siteId: string;
      customerId: string;
      vehicleId: string;
      scheduledStartAt: string;
      serviceTypes: Array<{ serviceTypeCode: string }>;
      notes?: string;
      acknowledgeCapacity?: boolean;
      overrideLatestStart?: boolean;
    }) => api.post<{ id: string }>('/appointments', payload),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && (err.body as { code?: string } | undefined)?.code === 'CAPACITY_FULL') {
        const b = err.body as { message?: string; capacity?: number; booked?: number };
        // CR-2026-105c warn-not-block: the advisor may continue knowingly; the override
        // is audited server-side. Shown inline (no window.confirm) so the reason is read.
        setCapacityWarning({ message: b.message ?? 'All service positions are booked for this time.', capacity: b.capacity, booked: b.booked });
        return;
      }
      if (err instanceof ApiError && err.status === 400 && (err.body as { code?: string } | undefined)?.code === 'AFTER_LATEST_START') {
        setLatestStartWarning((err.body as { message?: string }).message ?? 'That time is after the latest allowed start.');
        return;
      }
    },
    onSuccess: async (data) => {
      if (state.holdId) {
        try {
          await api.post(`/schedule-holds/${state.holdId}/convert`, { appointmentId: data.id });
        } catch {
          /* the appointment is booked regardless; the hold can be released manually */
        }
      }
      queryClient.invalidateQueries({ queryKey: ['staff-availability'] });
      queryClient.invalidateQueries({ queryKey: ['public-availability'] });
      dispatch({ type: 'CREATED', id: data.id });
    },
  });

  const selectedServices = useMemo(
    () => (serviceTypesQuery.data ?? []).filter((st) => state.serviceCodes.includes(st.code)),
    [serviceTypesQuery.data, state.serviceCodes],
  );
  const partsServices = selectedServices.filter((s) => s.partsPrepositionRequired);
  const filteredServices = (serviceTypesQuery.data ?? []).filter((st) => {
    const q = serviceSearch.trim().toLowerCase();
    return !q || st.name.toLowerCase().includes(q) || (st.family ?? '').toLowerCase().includes(q) || st.code.toLowerCase().includes(q);
  });

  const tz = availabilityQuery.data?.timezone;
  const customerName = state.customer ? `${state.customer.firstName} ${state.customer.lastName}`.trim() || 'Customer' : '';
  const vehicleLabel = state.vehicle ? `${state.vehicle.plateNumber}${[state.vehicle.modelYear, state.vehicle.make, state.vehicle.model].filter(Boolean).length ? ` · ${[state.vehicle.modelYear, state.vehicle.make, state.vehicle.model].filter(Boolean).join(' ')}` : ''}` : '';

  function submit(extra: { acknowledgeCapacity?: boolean; overrideLatestStart?: boolean } = {}) {
    if (!state.customer || !state.vehicle || !state.slot || state.serviceCodes.length === 0) return;
    createMutation.mutate({
      siteId,
      customerId: state.customer.id,
      vehicleId: state.vehicle.id,
      scheduledStartAt: state.slot.startAt,
      serviceTypes: state.serviceCodes.map((code) => ({ serviceTypeCode: code })),
      notes: state.notes.trim() || undefined,
      ...(extra.acknowledgeCapacity || state.acknowledgeCapacity ? { acknowledgeCapacity: true } : {}),
      ...(extra.overrideLatestStart || state.overrideLatestStart ? { overrideLatestStart: true } : {}),
    });
  }

  const go = (s: (typeof WIZARD_STEPS)[number]) => {
    setCapacityWarning(null);
    setLatestStartWarning(null);
    dispatch({ type: 'GO_TO', step: s });
  };

  // --- Success ---
  if (state.step === 'success') {
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
              {state.slot ? fmtWhen(state.slot.startAt, tz) : ''} for {customerName}
              {state.vehicle ? ` · ${state.vehicle.plateNumber}` : ''}
            </p>
            <div className="mt-6 flex gap-3 justify-center">
              <a href="/appointments" className="btn-secondary">View Appointments</a>
              <button type="button" onClick={() => { dispatch({ type: 'RESET' }); setSearchTerm(''); setFromKey(todayKey()); }} className="btn-primary">
                Schedule Another
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const days = availabilityQuery.data?.days ?? [];
  const selectedDay = days.find((d) => d.date === state.dateKey) ?? null;

  return (
    <div className="page-container max-w-2xl">
      <PageHeader title="New Appointment" breadcrumbs={[{ label: 'Appointments', href: '/appointments' }, { label: 'New' }]} />

      <StepIndicator current={state.step} state={state} onGo={go} />

      {/* Running summary with Change affordances (never plain text) */}
      {(state.customer || state.vehicle || state.serviceCodes.length > 0) && state.step !== 'customer' && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2" data-testid="wizard-summary">
          {state.customer && <Summary label="Customer" value={customerName || state.customer.customerNumber || 'Loading…'} onChange={() => go('customer')} />}
          {state.vehicle && state.step !== 'vehicle' && <Summary label="Vehicle" value={vehicleLabel} onChange={() => go('vehicle')} />}
          {state.serviceCodes.length > 0 && state.step !== 'services' && (
            <Summary label="Service request" value={selectedServices.map((s) => s.name).join(', ') || `${state.serviceCodes.length} selected`} onChange={() => go('services')} />
          )}
          {state.dateKey && (state.step === 'time' || state.step === 'review') && <Summary label="Date" value={fmtDayLabel(state.dateKey)} onChange={() => go('date')} />}
          {state.slot && state.step === 'review' && <Summary label="Time" value={fmtWhen(state.slot.startAt, tz)} onChange={() => go('time')} />}
        </div>
      )}

      {/* 1. Customer */}
      {state.step === 'customer' && (
        <div className="card">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Step 1: Customer</h2></div>
          <div className="card-body space-y-4">
            {state.customer && (
              <Summary label="Selected customer" value={customerName || state.customer.customerNumber || 'Loading…'} onChange={() => dispatch({ type: 'CLEAR_CUSTOMER' })} />
            )}
            <div>
              <label className="input-label">Search</label>
              <input
                type="text"
                placeholder="Phone, licence plate, or first and last name…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="input-field"
                autoFocus
              />
            </div>
            {customersQuery.data && customersQuery.data.length > 0 && (
              <div className="border border-slate-200 rounded-md overflow-hidden">
                {customersQuery.data.map((c, idx) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => dispatch({ type: 'SELECT_CUSTOMER', customer: c })}
                    className={`w-full min-h-11 text-left px-4 py-3 hover:bg-blue-50 transition-colors ${idx > 0 ? 'border-t border-slate-100' : ''} ${state.customer?.id === c.id ? 'bg-blue-50' : ''}`}
                  >
                    <p className="text-sm font-medium text-slate-900">{c.firstName} {c.lastName}</p>
                    <p className="text-xs text-slate-500">{c.customerNumber}</p>
                  </button>
                ))}
              </div>
            )}
            {debouncedTerm.length >= 2 && customersQuery.data?.length === 0 && (
              <p className="text-sm text-slate-500 text-center py-4">No customers found — try a phone number, a licence plate, or first and last name.</p>
            )}
            {state.customer && (
              <div className="flex justify-end">
                <button type="button" onClick={() => go('vehicle')} className="btn-primary" disabled={!canEnter(state, 'vehicle')}>Next: Vehicle</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. Vehicle */}
      {state.step === 'vehicle' && (
        <div className="card">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Step 2: Vehicle</h2></div>
          <div className="card-body space-y-3">
            {customerDetailQuery.isLoading && <p className="text-sm text-slate-500">Loading vehicles…</p>}
            {state.customerVehicles && state.customerVehicles.length === 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {customerName || 'This customer'} has no vehicles on file.{' '}
                <a href={`/customers/${state.customer?.id}`} className="underline font-medium">Add a vehicle</a> first, then book.
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(state.customerVehicles ?? []).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => dispatch({ type: 'SELECT_VEHICLE', vehicle: v })}
                  className={`min-h-11 border rounded-lg px-4 py-4 text-left transition-colors ${state.vehicle?.id === v.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-blue-400 hover:bg-blue-50/50'}`}
                >
                  <p className="text-sm font-bold font-mono text-slate-900">{v.plateNumber}</p>
                  <p className="text-xs text-slate-500 mt-1">{[v.modelYear, v.make, v.model].filter(Boolean).join(' ') || 'Unknown vehicle'}</p>
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between pt-2">
              <button type="button" onClick={() => go('customer')} className="btn-secondary">Back</button>
              <button type="button" onClick={() => go('services')} className="btn-primary" disabled={!canEnter(state, 'services')}>Next: Service request</button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Service request */}
      {state.step === 'services' && (
        <div className="card">
          <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Step 3: Service request</h2></div>
          <div className="card-body space-y-4">
            <input type="text" value={serviceSearch} onChange={(e) => setServiceSearch(e.target.value)} placeholder="Search services by name, family, or code…" className="input-field" autoFocus />
            {serviceTypesQuery.data && (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {filteredServices.map((st) => {
                  const on = state.serviceCodes.includes(st.code);
                  return (
                    <label key={st.code} className={`flex min-h-11 items-center gap-3 rounded-md border px-4 py-3 cursor-pointer transition-colors ${on ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                      <input type="checkbox" checked={on} onChange={() => dispatch({ type: 'TOGGLE_SERVICE', code: st.code })} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-900">{st.name}</p>
                        <p className="text-xs text-slate-500">{st.family}</p>
                      </div>
                    </label>
                  );
                })}
                {filteredServices.length === 0 && <p className="text-sm text-slate-500 text-center py-4">No services match &ldquo;{serviceSearch}&rdquo;.</p>}
              </div>
            )}
            {partsServices.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                <p className="text-sm font-medium text-amber-800">⚠ May require parts</p>
                <p className="text-xs text-amber-700 mt-0.5">{partsServices.map((s) => s.name).join(', ')} may need parts — arrange preposition in the parts system before service.</p>
              </div>
            )}
            <div>
              <label className="input-label">Customer&apos;s concern / notes (optional)</label>
              <textarea value={state.notes} onChange={(e) => dispatch({ type: 'SET_NOTES', notes: e.target.value })} rows={2} placeholder="What the customer reported, special instructions…" className="input-field" />
            </div>
            <div className="flex items-center justify-between border-t border-slate-100 pt-4">
              <button type="button" onClick={() => go('vehicle')} className="btn-secondary">Back</button>
              <div className="flex items-center gap-3">
                <p className="text-sm text-slate-600">{state.serviceCodes.length} service{state.serviceCodes.length !== 1 ? 's' : ''}</p>
                <button type="button" onClick={() => go('date')} className="btn-primary" disabled={!canEnter(state, 'date')}>Next: Date</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Date */}
      {state.step === 'date' && (
        <div className="card">
          <div className="card-header">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Step 4: Date</h2>
              {availabilityQuery.data && <span className="text-xs text-slate-500">About {availabilityQuery.data.plannedMinutes} min per appointment</span>}
            </div>
          </div>
          <div className="card-body space-y-3">
            {availabilityQuery.isLoading && <p className="text-sm text-slate-500">Checking the schedule…</p>}
            {availabilityQuery.isError && <p className="text-sm text-red-700">Could not load availability. {availabilityQuery.error instanceof Error ? availabilityQuery.error.message : ''}</p>}
            {availabilityQuery.data && (
              <>
                {availabilityQuery.data.nextAvailable && (
                  <button
                    type="button"
                    onClick={() => {
                      const key = availabilityQuery.data!.days.find((d) => d.slots.some((s) => s.startAt === availabilityQuery.data!.nextAvailable!.startAt))?.date;
                      if (key) dispatch({ type: 'SET_DATE', dateKey: key });
                      dispatch({ type: 'SELECT_SLOT', slot: availabilityQuery.data!.nextAvailable! });
                    }}
                    className="w-full rounded-xl border-2 border-blue-600 bg-blue-50 p-4 text-left hover:bg-blue-100"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">Next available</p>
                    <p className="mt-1 text-lg font-bold text-slate-900">{fmtWhen(availabilityQuery.data.nextAvailable.startAt, tz)}</p>
                  </button>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="wizard-days">
                  {days.map((d) => (
                    <button
                      key={d.date}
                      type="button"
                      disabled={d.closed || d.availableCount === 0}
                      onClick={() => dispatch({ type: 'SET_DATE', dateKey: d.date })}
                      className={`min-h-11 rounded-lg border px-3 py-2 text-left transition-colors ${
                        state.dateKey === d.date ? 'border-blue-500 bg-blue-50' : d.closed || d.availableCount === 0 ? 'border-slate-100 bg-slate-50 text-slate-400 cursor-not-allowed' : 'border-slate-200 hover:border-blue-400 hover:bg-blue-50/50'
                      }`}
                    >
                      <p className="text-sm font-semibold">{fmtDayLabel(d.date)}</p>
                      <p className="text-xs">{d.closed ? 'Closed' : d.availableCount === 0 ? 'Full' : `${d.availableCount} open`}</p>
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-between pt-1">
                  <button type="button" onClick={() => setFromKey(addDays(fromKey, -14) < todayKey() ? todayKey() : addDays(fromKey, -14))} className="btn-secondary min-h-9 px-3 py-1 text-xs" disabled={fromKey <= todayKey()}>← Earlier</button>
                  <button type="button" onClick={() => setFromKey(addDays(fromKey, 14))} className="btn-secondary min-h-9 px-3 py-1 text-xs">Later dates →</button>
                </div>
              </>
            )}
            <div className="flex items-center justify-between border-t border-slate-100 pt-4">
              <button type="button" onClick={() => go('services')} className="btn-secondary">Back</button>
              <button type="button" onClick={() => go('time')} className="btn-primary" disabled={!canEnter(state, 'time')}>Next: Available time</button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Available time */}
      {state.step === 'time' && (
        <div className="card">
          <div className="card-header">
            <h2 className="text-sm font-semibold text-slate-900">Step 5: Available time — {state.dateKey ? fmtDayLabel(state.dateKey) : ''}</h2>
          </div>
          <div className="card-body space-y-3">
            {availabilityQuery.isLoading && <p className="text-sm text-slate-500">Checking the schedule…</p>}
            {availabilityQuery.data && (
              <SlotPicker
                data={availabilityQuery.data}
                selected={state.slot}
                onSelect={(slot) => dispatch({ type: 'SELECT_SLOT', slot })}
                onlyDate={state.dateKey}
                emptyText={selectedDay?.closed ? 'The service centre is closed on this day.' : 'Every position is booked on this day. Pick another date, or book past capacity from the review step if the manager agrees.'}
              />
            )}
            <div className="flex items-center justify-between border-t border-slate-100 pt-4">
              <button type="button" onClick={() => go('date')} className="btn-secondary">Back</button>
              <button type="button" onClick={() => go('review')} className="btn-primary" disabled={!canEnter(state, 'review')}>Next: Review</button>
            </div>
          </div>
        </div>
      )}

      {/* 6. Review + Confirm */}
      {state.step === 'review' && state.slot && (
        <div className="space-y-4">
          <div className="card">
            <div className="card-header"><h2 className="text-sm font-semibold text-slate-900">Step 6: Review</h2></div>
            <div className="card-body space-y-2 text-sm">
              <div className="flex justify-between gap-4"><span className="text-slate-500">Customer</span><span className="font-medium text-slate-900">{customerName}</span></div>
              <div className="flex justify-between gap-4"><span className="text-slate-500">Vehicle</span><span className="font-medium text-slate-900">{vehicleLabel}</span></div>
              <div className="flex justify-between gap-4"><span className="text-slate-500">Service request</span><span className="text-right font-medium text-slate-900">{selectedServices.map((s) => s.name).join(', ')}</span></div>
              <div className="flex justify-between gap-4"><span className="text-slate-500">Date &amp; time</span><span className="font-bold text-slate-900">{fmtWhen(state.slot.startAt, tz)}</span></div>
              <div className="flex justify-between gap-4"><span className="text-slate-500">Planned time</span><span className="text-slate-900">About {availabilityQuery.data?.plannedMinutes ?? '—'} minutes</span></div>
              {state.notes.trim() && <div className="flex justify-between gap-4"><span className="text-slate-500">Notes</span><span className="text-right text-slate-900">{state.notes}</span></div>}
              <p className="pt-2 text-xs text-slate-500">Nothing is reserved until you press Confirm. The slot is re-checked at that moment.</p>
            </div>
          </div>

          {capacityWarning && (
            <div className="card border-amber-300 bg-amber-50" data-testid="capacity-warning">
              <div className="card-body space-y-2">
                <p className="text-sm font-semibold text-amber-900">Every service position is booked for this time</p>
                <p className="text-xs text-amber-800">{capacityWarning.message}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => { setCapacityWarning(null); go('time'); }} className="btn-secondary min-h-9 text-xs">Pick another time</button>
                  <button
                    type="button"
                    onClick={() => { dispatch({ type: 'ACKNOWLEDGE_CAPACITY', value: true }); setCapacityWarning(null); submit({ acknowledgeCapacity: true }); }}
                    className="btn-primary min-h-9 text-xs"
                    disabled={createMutation.isPending}
                  >
                    Book anyway (recorded)
                  </button>
                </div>
              </div>
            </div>
          )}

          {latestStartWarning && (
            <div className="card border-amber-300 bg-amber-50" data-testid="latest-start-warning">
              <div className="card-body space-y-2">
                <p className="text-sm font-semibold text-amber-900">After the latest allowed start</p>
                <p className="text-xs text-amber-800">{latestStartWarning}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => { setLatestStartWarning(null); go('time'); }} className="btn-secondary min-h-9 text-xs">Pick an earlier time</button>
                  <button
                    type="button"
                    onClick={() => { dispatch({ type: 'OVERRIDE_LATEST_START', value: true }); setLatestStartWarning(null); submit({ overrideLatestStart: true }); }}
                    className="btn-primary min-h-9 text-xs"
                    disabled={createMutation.isPending}
                  >
                    Book after the latest start anyway (recorded)
                  </button>
                </div>
              </div>
            </div>
          )}

          {createMutation.isError && !capacityWarning && !latestStartWarning && (
            <div className="card border-red-200 bg-red-50">
              <div className="card-body">
                <p className="text-sm text-red-700">{createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create appointment'}</p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <button type="button" onClick={() => go('time')} className="btn-secondary">Back</button>
            <button type="button" onClick={() => submit()} disabled={createMutation.isPending || !!capacityWarning || !!latestStartWarning} className="btn-success px-8 py-2.5">
              {createMutation.isPending ? 'Confirming…' : 'Confirm appointment'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
