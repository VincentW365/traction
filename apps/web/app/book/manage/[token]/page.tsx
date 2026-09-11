'use client';

/**
 * CR-2026-105c — customer booking management (public, token-gated). View the
 * appointment, cancel it, or move it; each action re-checks capacity on the
 * server and frees the old slot immediately. Never links to the staff app.
 */

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PublicApiError, fmtWhen, publicApi } from '../../../../lib/public-api';
import { SlotPicker, type Availability, type Slot } from '../../slot-picker';

interface ManageView {
  appointmentNumber: string;
  status: string;
  scheduledStartAt: string;
  plannedMinutes: number;
  services: Array<{ code: string; name: string }>;
  firstName: string;
  vehicle: { plateMasked: string; make: string | null; model: string | null; modelYear: number | null };
  site: { name: string; timezone: string };
  arrivalInstructions: string;
  canCancel: boolean;
  canReschedule: boolean;
  cancelBlockedReason: string | null;
  rescheduleBlockedReason: string | null;
  reschedulesUsed: number;
  maxReschedules: number;
}

const STATUS_COPY: Record<string, { label: string; cls: string }> = {
  CONFIRMED: { label: 'Confirmed', cls: 'bg-emerald-100 text-emerald-800' },
  RESCHEDULED: { label: 'Confirmed (moved)', cls: 'bg-emerald-100 text-emerald-800' },
  DRAFT: { label: 'Pending', cls: 'bg-slate-100 text-slate-700' },
  CHECKED_IN: { label: 'Checked in', cls: 'bg-blue-100 text-blue-800' },
  IN_PROGRESS: { label: 'In service', cls: 'bg-blue-100 text-blue-800' },
  COMPLETED: { label: 'Completed', cls: 'bg-slate-100 text-slate-700' },
  MISSED: { label: 'Missed', cls: 'bg-amber-100 text-amber-800' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-red-100 text-red-800' },
};

export default function ManageBookingPage() {
  const params = useParams();
  const token = params.token as string;
  const qc = useQueryClient();
  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const q = useQuery<ManageView>({
    queryKey: ['public-manage', token],
    queryFn: () => publicApi.get(`/public/booking/manage/${encodeURIComponent(token)}`),
    retry: (count, err) => !(err instanceof PublicApiError && err.status === 404) && count < 2,
  });
  const codes = q.data?.services.map((s) => s.code) ?? [];
  const availabilityQ = useQuery<Availability>({
    queryKey: ['public-availability', codes.join(','), 'manage'],
    queryFn: () => publicApi.get(`/public/booking/availability?serviceCodes=${encodeURIComponent(codes.join(','))}&days=14`),
    enabled: mode === 'reschedule' && codes.length > 0,
  });

  async function cancel() {
    if (!window.confirm('Cancel this appointment? Your time will be released to other customers.')) return;
    setBusy(true);
    setError(null);
    try {
      await publicApi.post(`/public/booking/manage/${encodeURIComponent(token)}/cancel`, {});
      setNotice('Your appointment has been cancelled.');
      await qc.invalidateQueries({ queryKey: ['public-manage', token] });
    } catch (e) {
      setError(e instanceof PublicApiError ? e.message : 'We could not cancel the appointment. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function reschedule() {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      await publicApi.post(`/public/booking/manage/${encodeURIComponent(token)}/reschedule`, { scheduledStartAt: slot.startAt });
      setNotice('Your appointment has been moved. We have sent you the new details.');
      setMode('view');
      setSlot(null);
      await qc.invalidateQueries({ queryKey: ['public-manage', token] });
    } catch (e) {
      if (e instanceof PublicApiError && e.code === 'SLOT_TAKEN') {
        setSlot(null);
        await qc.invalidateQueries({ queryKey: ['public-availability'] });
        setError('Sorry — that time was just taken. Here are the current openings.');
      } else {
        setError(e instanceof PublicApiError ? e.message : 'We could not move the appointment. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-5 flex items-center gap-3">
          <img src="/brand-mark.png" alt="" className="h-9 w-auto object-contain" />
          <div>
            <p className="text-base font-bold text-slate-900">{q.data?.site.name ?? 'Service Centre'}</p>
            <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">Your appointment</p>
          </div>
        </div>

        {q.isLoading && <div className="card p-6 text-center text-sm text-slate-500">Loading your booking…</div>}
        {q.isError && (
          <div className="card p-6 text-center text-sm text-slate-700">
            {q.error instanceof PublicApiError && q.error.status === 404
              ? 'This booking link is invalid or has expired. Please contact the front desk.'
              : 'We could not load your booking. Please try again shortly.'}
          </div>
        )}

        {q.data && (
          <div className="space-y-4">
            {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}
            {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

            <div className="card overflow-hidden">
              <div className="flex items-center justify-between bg-slate-900 px-5 py-4 text-white">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-300">Reference</p>
                  <p className="text-xl font-bold tabular-nums">{q.data.appointmentNumber}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COPY[q.data.status]?.cls ?? 'bg-slate-100 text-slate-700'}`}>
                  {STATUS_COPY[q.data.status]?.label ?? q.data.status}
                </span>
              </div>
              <div className="space-y-2 px-5 py-4 text-sm">
                <Row label="Customer" value={q.data.firstName} />
                <Row label="Date & arrival time" value={fmtWhen(q.data.scheduledStartAt, q.data.site.timezone)} strong />
                <Row label="Vehicle" value={[q.data.vehicle.modelYear, q.data.vehicle.make, q.data.vehicle.model].filter(Boolean).join(' ') || 'Vehicle'} sub={q.data.vehicle.plateMasked} />
                <Row label="Service" value={q.data.services.map((s) => s.name).join(', ')} />
                <Row label="Expected service time" value={`About ${q.data.plannedMinutes} minutes`} />
                <div className="rounded-lg bg-slate-50 p-3 text-slate-700">{q.data.arrivalInstructions}</div>
              </div>
            </div>

            {mode === 'view' && (
              <div className="card p-4">
                <p className="mb-3 text-sm font-semibold text-slate-800">Need to change it?</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={!q.data.canReschedule || busy} onClick={() => { setMode('reschedule'); setNotice(null); }} className="btn-primary disabled:opacity-50">Move appointment</button>
                  <button type="button" disabled={!q.data.canCancel || busy} onClick={() => void cancel()} className="btn-secondary text-red-700 disabled:opacity-50">Cancel appointment</button>
                </div>
                {!q.data.canReschedule && q.data.rescheduleBlockedReason && <p className="mt-2 text-xs text-slate-500">{q.data.rescheduleBlockedReason}</p>}
                {!q.data.canCancel && q.data.cancelBlockedReason && q.data.cancelBlockedReason !== q.data.rescheduleBlockedReason && (
                  <p className="mt-1 text-xs text-slate-500">{q.data.cancelBlockedReason}</p>
                )}
                {q.data.canReschedule && <p className="mt-2 text-[11px] text-slate-400">Moved {q.data.reschedulesUsed} of {q.data.maxReschedules} times allowed online.</p>}
              </div>
            )}

            {mode === 'reschedule' && (
              <div className="card space-y-4 p-4">
                <p className="text-sm font-semibold text-slate-800">Choose a new time</p>
                {availabilityQ.isLoading && <p className="text-sm text-slate-500">Checking the schedule…</p>}
                {availabilityQ.data && <SlotPicker data={availabilityQ.data} selected={slot} onSelect={setSlot} />}
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setMode('view'); setSlot(null); }} className="btn-secondary" disabled={busy}>Back</button>
                  <button type="button" disabled={!slot || busy} onClick={() => void reschedule()} className="btn-primary flex-1 disabled:opacity-50">{busy ? 'Moving…' : 'Confirm new time'}</button>
                </div>
              </div>
            )}

            <p className="text-center text-xs text-slate-400">
              Want another appointment? <a href="/book" className="text-blue-600 hover:underline">Book online</a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className={`text-right ${strong ? 'font-bold text-slate-900' : 'text-slate-800'}`}>
        {value}
        {sub && <span className="block font-mono text-xs text-slate-500">{sub}</span>}
      </span>
    </div>
  );
}
