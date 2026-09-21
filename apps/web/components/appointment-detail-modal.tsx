'use client';

/**
 * Shared appointment detail modal (CR-2026-025).
 * Opens from the Appointments page and the Schedule. Shows the appointment
 * details and offers status-gated actions: inline Check In (captures the minimal
 * intake the API needs — mileage is required for service jobs), Reschedule, and
 * Cancel. On check-in it shows the resulting queue ticket. No tokens are logged.
 */
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../lib/api-client';
import { StatusBadge } from './status-badge';

interface ApptDetail {
  id: string;
  status: string;
  scheduledStartAt: string;
  scheduledEndAt: string | null;
  notes: string | null;
  customer: {
    id: string; firstName: string; lastName: string; phone: string; email: string | null;
    notificationOptInEmail: boolean;
  };
  vehicle: {
    id: string; plateNumber: string; make: string | null; model: string | null;
    modelYear: number | null; color: string | null; odometer: number | null; weightClass: string | null;
  } | null;
  services: Array<{ id: string; qty: number; serviceType: { name: string; code: string; baseDurationMinutes: number; requiresMileage: boolean } }>;
}

interface CheckInResult {
  queueTicket: { ticketNumber: string };
  priorityClass: string;
  etaStartAt: string | null;
  customerStatusUrl?: string | null;
}

// CR-2026-070 — a RESCHEDULED appointment is still active and must be checkable-in.
const CHECKIN_STATUSES = ['CONFIRMED', 'DRAFT', 'RESCHEDULED'];
const RESCHEDULE_STATUSES = ['DRAFT', 'CONFIRMED', 'RESCHEDULED'];
const isCancellable = (s: string) => !['CANCELLED', 'COMPLETED'].includes(s);
const WEIGHT_CLASSES = ['LIGHT', 'STANDARD', 'HEAVY'];
const OIL_BRANDS = ['Amsoil', 'Liqui Moly', 'Valvoline', 'Castrol', 'Mobil 1', 'Other'];
const OIL_GRADES = ['0W-20', '5W-20', '5W-30', '10W-30', '10W-40', '15W-40', '0W-40', 'Other'];

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const toDateInput = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const toTimeInput = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

type Mode = 'view' | 'checkin' | 'reschedule' | 'cancel';

export function AppointmentDetailModal({
  appointmentId,
  onClose,
  onChanged,
}: {
  appointmentId: string;
  onClose: () => void;
  /** Called after a check-in / reschedule / cancel so the parent can refetch. */
  onChanged?: () => void;
}) {
  const { data: appt, isLoading, isError } = useQuery<ApptDetail>({
    queryKey: ['appointment-detail', appointmentId],
    queryFn: () => api.get(`/appointments/${appointmentId}`),
  });

  const [mode, setMode] = useState<Mode>('view');
  const [result, setResult] = useState<CheckInResult | null>(null);

  // check-in intake
  const [mileageIn, setMileageIn] = useState('');
  const [oilBrand, setOilBrand] = useState('');
  const [oilBrandOther, setOilBrandOther] = useState('');
  const [oilGrade, setOilGrade] = useState('');
  const [oilGradeOther, setOilGradeOther] = useState('');
  const [weightClass, setWeightClass] = useState('STANDARD');
  const [color, setColor] = useState('');
  const [optEmail, setOptEmail] = useState(false);
  // reschedule
  const [rDate, setRDate] = useState('');
  const [rTime, setRTime] = useState('');
  const [rNotes, setRNotes] = useState('');
  // cancel
  const [cancelReason, setCancelReason] = useState('');

  const requiresMileage = !!appt?.services.some((s) => s.serviceType.requiresMileage);

  // Local "today" for the reschedule date picker + a past-time guard (CR-2026-041):
  // any later time today is allowed, but we never submit a slot earlier than now.
  const todayStr = toDateInput(new Date().toISOString());
  const rStartMs = rDate && rTime ? new Date(`${rDate}T${rTime}:00`).getTime() : null;
  const rIsPast = rStartMs !== null && rStartMs <= Date.now();

  const checkInMutation = useMutation({
    mutationFn: () =>
      api.post<CheckInResult>(`/appointments/${appointmentId}/check-in`, {
        mileageIn: mileageIn ? parseInt(mileageIn, 10) : undefined,
        oilBrand: (oilBrand === 'Other' ? (oilBrandOther.trim() || 'Other') : oilBrand) || undefined,
        oilGrade: (oilGrade === 'Other' ? (oilGradeOther.trim() || 'Other') : oilGrade) || undefined,
        vehicleWeightClass: weightClass || undefined,
        color: color || undefined,
        notificationOptInEmail: optEmail,
      }),
    onSuccess: (data) => { setResult(data); onChanged?.(); },
  });

  const rescheduleMutation = useMutation({
    mutationFn: () =>
      api.patch(`/appointments/${appointmentId}`, {
        scheduledStartAt: new Date(`${rDate}T${rTime}:00`).toISOString(),
        notes: rNotes || undefined,
      }),
    onSuccess: () => { onChanged?.(); setMode('view'); },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post(`/appointments/${appointmentId}/cancel`, { reason: cancelReason.trim() || 'Cancelled by staff' }),
    onSuccess: () => { onChanged?.(); onClose(); },
  });

  function openCheckin() {
    if (!appt) return;
    setMileageIn('');
    setOilBrand(''); setOilBrandOther(''); setOilGrade(''); setOilGradeOther('');
    setWeightClass(appt.vehicle?.weightClass ?? 'STANDARD');
    setColor(appt.vehicle?.color ?? '');
    setOptEmail(appt.customer.notificationOptInEmail);
    checkInMutation.reset();
    setMode('checkin');
  }
  function openReschedule() {
    if (!appt) return;
    // Don't pre-fill a past date — if the original slot is behind us, start from today
    // (the user is rescheduling forward). Keep the original time as a starting point.
    const origDate = toDateInput(appt.scheduledStartAt);
    setRDate(origDate < todayStr ? todayStr : origDate);
    setRTime(toTimeInput(appt.scheduledStartAt));
    setRNotes('');
    rescheduleMutation.reset();
    setMode('reschedule');
  }

  const canCheckIn = !!appt && CHECKIN_STATUSES.includes(appt.status);
  const canReschedule = !!appt && RESCHEDULE_STATUSES.includes(appt.status);
  const canCancel = !!appt && isCancellable(appt.status);
  const checkInDisabled = checkInMutation.isPending || (requiresMileage && !mileageIn.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-lg max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="card-header flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Appointment Details</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label="Close">&times;</button>
        </div>

        <div className="card-body">
          {isLoading && <p className="py-8 text-center text-sm text-slate-500">Loading…</p>}
          {isError && <p className="py-8 text-center text-sm text-red-600">Failed to load appointment.</p>}

          {/* ---- check-in success ---- */}
          {appt && result && (
            <div className="text-center py-2">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
                <svg className="h-6 w-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <h4 className="text-base font-bold text-slate-900">Checked In</h4>
              <p className="mt-1 text-sm text-slate-500">{appt.customer.firstName} {appt.customer.lastName}</p>
              <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                <div><p className="input-label">Ticket</p><p className="font-mono text-lg font-bold text-slate-900">{result.queueTicket.ticketNumber}</p></div>
                <div><p className="input-label">Priority</p><div className="mt-1"><StatusBadge status={result.priorityClass} /></div></div>
                <div><p className="input-label">ETA</p><p className="text-sm font-semibold text-slate-900 mt-1">{result.etaStartAt ? fmtTime(result.etaStartAt) : 'Pending'}</p></div>
              </div>

              {/*
                CR-2026-085 — the status link is minted for appointments too, and the
                API has always returned it here, but this panel never rendered it. That
                is why the link appeared to exist only for walk-ins.
              */}
              {result.customerStatusUrl && (
                <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-left">
                  <p className="text-[11px] uppercase tracking-wider text-blue-600 mb-1">Customer Status Link</p>
                  <code className="block text-xs text-slate-700 break-all">
                    {result.customerStatusUrl}
                  </code>
                  <p className="text-[11px] text-blue-700 mt-1.5">
                    Also available any time from the ticket, if the customer loses it.
                  </p>
                </div>
              )}

              <button onClick={onClose} className="btn-primary text-xs mt-6">Done</button>
            </div>
          )}

          {/* ---- detail + actions ---- */}
          {appt && !result && (
            <div className="space-y-4">
              {/* summary */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-lg font-bold text-slate-900">{fmtTime(appt.scheduledStartAt)}{appt.scheduledEndAt ? ` – ${fmtTime(appt.scheduledEndAt)}` : ''}</p>
                  <p className="text-xs text-slate-500">{fmtDate(appt.scheduledStartAt)}</p>
                </div>
                <StatusBadge status={appt.status} />
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <p className="input-label">Customer</p>
                  <p className="font-medium text-slate-900">{appt.customer.firstName} {appt.customer.lastName}</p>
                  <p className="text-xs text-slate-500">{appt.customer.phone}</p>
                </div>
                <div>
                  <p className="input-label">Vehicle</p>
                  {appt.vehicle ? (
                    <>
                      <p className="font-mono font-medium text-slate-900">{appt.vehicle.plateNumber}</p>
                      <p className="text-xs text-slate-500">{[appt.vehicle.modelYear, appt.vehicle.make, appt.vehicle.model].filter(Boolean).join(' ') || '—'}</p>
                    </>
                  ) : <p className="text-xs text-slate-400">No vehicle</p>}
                </div>
              </div>

              <div>
                <p className="input-label">Services</p>
                {appt.services.length === 0 ? (
                  <p className="text-xs text-slate-400">No services</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {appt.services.map((s) => (
                      <span key={s.id} className="badge bg-blue-50 text-blue-700">{s.serviceType.name}{s.qty > 1 ? ` ×${s.qty}` : ''}</span>
                    ))}
                  </div>
                )}
              </div>

              {appt.notes && (
                <div><p className="input-label">Notes</p><p className="text-sm text-slate-700 whitespace-pre-wrap">{appt.notes}</p></div>
              )}

              {/* ---- mode: view (action buttons) ---- */}
              {mode === 'view' && (
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                  {canCheckIn && <button onClick={openCheckin} className="btn-success text-xs">Check In</button>}
                  {canReschedule && <button onClick={openReschedule} className="btn-secondary text-xs">Reschedule</button>}
                  {canCancel && <button onClick={() => { setCancelReason(''); cancelMutation.reset(); setMode('cancel'); }} className="btn-secondary text-xs text-red-600">Cancel Appt</button>}
                  {!canCheckIn && !canReschedule && !canCancel && <p className="text-xs text-slate-400">No actions available for this status.</p>}
                </div>
              )}

              {/* ---- mode: check-in intake ---- */}
              {mode === 'checkin' && (
                <div className="space-y-3 pt-3 border-t border-slate-100">
                  <p className="text-sm font-semibold text-slate-900">Check-In Intake</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="input-label">Mileage In{requiresMileage ? ' *' : ''}</label>
                      <input type="number" min="0" value={mileageIn} onChange={(e) => setMileageIn(e.target.value)} className="input-field" placeholder="e.g., 45230" />
                    </div>
                    <div>
                      <label className="input-label">Vehicle Weight</label>
                      <select value={weightClass} onChange={(e) => setWeightClass(e.target.value)} className="input-field">
                        {WEIGHT_CLASSES.map((w) => <option key={w} value={w}>{w[0] + w.slice(1).toLowerCase()}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="input-label">Oil Brand</label>
                      <select value={oilBrand} onChange={(e) => setOilBrand(e.target.value)} className="input-field">
                        <option value="">— Select —</option>
                        {OIL_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                      </select>
                      {oilBrand === 'Other' && (
                        <input type="text" value={oilBrandOther} onChange={(e) => setOilBrandOther(e.target.value)} className="input-field mt-2" placeholder="Type oil brand (optional)" />
                      )}
                    </div>
                    <div>
                      <label className="input-label">Oil Grade</label>
                      <select value={oilGrade} onChange={(e) => setOilGrade(e.target.value)} className="input-field">
                        <option value="">— Select —</option>
                        {OIL_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                      </select>
                      {oilGrade === 'Other' && (
                        <input type="text" value={oilGradeOther} onChange={(e) => setOilGradeOther(e.target.value)} className="input-field mt-2" placeholder="Type oil grade (optional)" />
                      )}
                    </div>
                    <div className="col-span-2">
                      <label className="input-label">Vehicle Color</label>
                      <input type="text" value={color} onChange={(e) => setColor(e.target.value)} className="input-field" placeholder="e.g., Silver" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={optEmail} onChange={(e) => setOptEmail(e.target.checked)} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />Customer agrees to service reminders and offers by email</label>
                  </div>
                  {requiresMileage && !mileageIn.trim() && <p className="text-xs text-amber-600">A mileage reading is required for these services.</p>}
                  {checkInMutation.isError && <p className="text-xs text-red-600">{checkInMutation.error instanceof Error ? checkInMutation.error.message : 'Check-in failed'}</p>}
                  <div className="flex items-center gap-2">
                    <button onClick={() => checkInMutation.mutate()} disabled={checkInDisabled} className="btn-success text-xs">{checkInMutation.isPending ? 'Checking in…' : 'Confirm Check-In'}</button>
                    <button onClick={() => setMode('view')} disabled={checkInMutation.isPending} className="btn-secondary text-xs">Back</button>
                  </div>
                </div>
              )}

              {/* ---- mode: reschedule ---- */}
              {mode === 'reschedule' && (
                <div className="space-y-3 pt-3 border-t border-slate-100">
                  <p className="text-sm font-semibold text-slate-900">Reschedule</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="input-label">Date</label><input type="date" min={todayStr} value={rDate} onChange={(e) => setRDate(e.target.value)} className="input-field" /></div>
                    <div><label className="input-label">Time</label><input type="time" min="08:00" max="17:00" step="900" value={rTime} onChange={(e) => setRTime(e.target.value)} className="input-field" /></div>
                  </div>
                  <div><label className="input-label">Reason (optional)</label><input type="text" value={rNotes} onChange={(e) => setRNotes(e.target.value)} className="input-field" placeholder="Reason for change" /></div>
                  {rIsPast && <p className="text-xs text-amber-600">That time has already passed. Pick a later time today or a future date.</p>}
                  {rescheduleMutation.isError && <p className="text-xs text-red-600">{rescheduleMutation.error instanceof Error ? rescheduleMutation.error.message : 'Failed to reschedule'}</p>}
                  <div className="flex items-center gap-2">
                    <button onClick={() => rescheduleMutation.mutate()} disabled={rescheduleMutation.isPending || !rDate || !rTime || rIsPast} className="btn-primary text-xs">{rescheduleMutation.isPending ? 'Saving…' : 'Save'}</button>
                    <button onClick={() => setMode('view')} disabled={rescheduleMutation.isPending} className="btn-secondary text-xs">Back</button>
                  </div>
                </div>
              )}

              {/* ---- mode: cancel ---- */}
              {mode === 'cancel' && (
                <div className="space-y-3 pt-3 border-t border-slate-100">
                  <p className="text-sm font-semibold text-slate-900">Cancel this appointment?</p>
                  <div><label className="input-label">Reason</label><input type="text" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} className="input-field" placeholder="Cancelled by staff" /></div>
                  {cancelMutation.isError && <p className="text-xs text-red-600">{cancelMutation.error instanceof Error ? cancelMutation.error.message : 'Failed to cancel'}</p>}
                  <div className="flex items-center gap-2">
                    <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} className="btn-danger text-xs">{cancelMutation.isPending ? 'Cancelling…' : 'Yes, Cancel'}</button>
                    <button onClick={() => setMode('view')} disabled={cancelMutation.isPending} className="btn-secondary text-xs">Keep It</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
