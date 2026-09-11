'use client';

/**
 * CR-2026-105c — Appointments & Bookings report (docs/120 §D4).
 * One server payload (`/reports/appointments`); screen, print and CSV reconcile.
 * Tells management whether self-service booking and the 80-minute planning
 * assumption are working: sources, cancellations, reschedules, no-shows, lead
 * time, on-time starts, utilisation and estimated-vs-actual completion.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { useAuth } from '../../../../hooks/use-auth';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../lib/export';

const ALLOWED_ROLES = ['ADMIN'];

interface Report {
  meta: {
    title: string;
    organisation: string;
    siteName: string | null;
    period: { start: string; end: string; days: number };
    generatedAt: string;
    generatedBy: string | null;
    definitions: { onTimeStartLateMinutes: number; capacity: number; defaultDurationMinutes: number };
  };
  hasData: boolean;
  totals: {
    total: number; staffCreated: number; selfService: number; selfServiceRate: number | null;
    cancelled: number; cancellationRate: number | null; rescheduled: number; rescheduleRate: number | null;
    missed: number; checkedIn: number; noShowRate: number | null;
    leadTimeMedianHours: number | null; leadTimeP90Hours: number | null;
    started: number; onTimeStarts: number; onTimeStartRate: number | null;
    bookedMinutes: number; capacityMinutes: number; availableCapacityMinutes: number; utilisationRate: number | null;
    etaVariance: { count: number; medianAbsMinutes: number | null; p90AbsMinutes: number | null; medianSignedMinutes: number | null };
    plannedVariance: { count: number; medianAbsMinutes: number | null; p90AbsMinutes: number | null };
  };
  byDay: Array<{ date: string; total: number; selfService: number; cancelled: number; missed: number; checkedIn: number; bookedMinutes: number; capacityMinutes: number }>;
  rows: Array<{
    id: string; appointmentNumber: string | null; day: string; scheduledStartAt: string; createdAt: string; leadHours: number;
    status: string; source: 'SELF_SERVICE' | 'STAFF'; customerNumber: string; plate: string; services: string[]; plannedMinutes: number;
    reschedules: number; checkedInAt: string | null; workStartedAt: string | null; onTime: boolean | null;
    estimatedCompletionAt: string | null; actualCompletionAt: string | null; varianceMinutes: number | null; plannedVarianceMinutes: number | null;
  }>;
}

function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function presetRange(key: string): { start: string; end: string } {
  const now = new Date();
  const day = (d: Date) => localISO(d);
  const shift = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const monday = (d: Date) => shift(d, -((d.getDay() + 6) % 7));
  switch (key) {
    case 'TODAY': return { start: day(now), end: day(now) };
    case 'YESTERDAY': return { start: day(shift(now, -1)), end: day(shift(now, -1)) };
    case 'THIS_WEEK': return { start: day(monday(now)), end: day(shift(monday(now), 6)) };
    case 'LAST_WEEK': return { start: day(shift(monday(now), -7)), end: day(shift(monday(now), -1)) };
    case 'THIS_MONTH': return { start: day(new Date(now.getFullYear(), now.getMonth(), 1)), end: day(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
    case 'LAST_MONTH': return { start: day(new Date(now.getFullYear(), now.getMonth() - 1, 1)), end: day(new Date(now.getFullYear(), now.getMonth(), 0)) };
    default: return { start: day(now), end: day(shift(now, 29)) };
  }
}
const PRESETS = [
  { key: 'TODAY', label: 'Today' }, { key: 'YESTERDAY', label: 'Yesterday' }, { key: 'THIS_WEEK', label: 'This Week' },
  { key: 'LAST_WEEK', label: 'Last Week' }, { key: 'THIS_MONTH', label: 'This Month' }, { key: 'LAST_MONTH', label: 'Last Month' },
];
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const hrs = (v: number | null | undefined) => (v == null ? '—' : `${v} h`);
const mins = (v: number | null | undefined) => (v == null ? '—' : `${v} min`);
const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-xl font-bold text-slate-900 tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

export default function AppointmentsReportPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const initial = presetRange('THIS_MONTH');
  const [preset, setPreset] = useState('THIS_MONTH');
  const [startDate, setStartDate] = useState(initial.start);
  const [endDate, setEndDate] = useState(initial.end);

  const q = useQuery<Report>({
    queryKey: ['appointments-report', siteId, startDate, endDate],
    queryFn: () => api.get(`/reports/appointments?siteId=${siteId}&startDate=${startDate}&endDate=${endDate}`),
    enabled: allowed && !!siteId,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Appointments & Bookings" subtitle="Report" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50"><p className="text-sm text-amber-800">You do not have permission to view this report.</p></div>
      </div>
    );
  }

  const r = q.data;
  const buildExport = (): ExportDocument | null => {
    if (!r) return null;
    return {
      title: 'Appointments & Bookings Report',
      filename: `berts-appointments_${startDate}_to_${endDate}`,
      subtitle: `Period ${startDate} to ${endDate} (${r.meta.period.days} days)`,
      meta: [
        ['Capacity (positions)', String(r.meta.definitions.capacity)],
        ['Planned minutes (default)', String(r.meta.definitions.defaultDurationMinutes)],
        ['Generated', new Date(r.meta.generatedAt).toLocaleString()],
      ],
      sections: [
        {
          heading: 'Totals',
          columns: ['Metric', 'Value'],
          rows: [
            ['Total appointments', r.totals.total], ['Staff-created', r.totals.staffCreated], ['Customer self-service', r.totals.selfService],
            ['Cancellation rate', pct(r.totals.cancellationRate)], ['Reschedule rate', pct(r.totals.rescheduleRate)], ['No-show rate', pct(r.totals.noShowRate)],
            ['Booking lead time (median)', hrs(r.totals.leadTimeMedianHours)], ['On-time service starts', pct(r.totals.onTimeStartRate)],
            ['Utilisation', pct(r.totals.utilisationRate)], ['Available capacity (min)', r.totals.availableCapacityMinutes],
            ['Est. vs actual completion (median |Δ|)', mins(r.totals.etaVariance.medianAbsMinutes)],
          ],
        },
        {
          heading: 'By day',
          columns: ['Date', 'Total', 'Self-service', 'Cancelled', 'Missed', 'Checked in', 'Booked min', 'Capacity min'],
          rows: r.byDay.map((d) => [d.date, d.total, d.selfService, d.cancelled, d.missed, d.checkedIn, d.bookedMinutes, d.capacityMinutes]),
        },
        {
          heading: 'Appointments',
          columns: ['Reference', 'Scheduled', 'Source', 'Status', 'Customer #', 'Plate', 'Services', 'Planned min', 'Lead h', 'Reschedules', 'On time', 'Est. completion', 'Actual completion', 'Variance min'],
          rows: r.rows.map((x) => [
            x.appointmentNumber ?? x.id.slice(0, 8), fmtDT(x.scheduledStartAt), x.source, x.status, x.customerNumber, x.plate, x.services.join(' + '),
            x.plannedMinutes, x.leadHours, x.reschedules, x.onTime == null ? '' : x.onTime ? 'Yes' : 'No', fmtDT(x.estimatedCompletionAt), fmtDT(x.actualCompletionAt), x.varianceMinutes ?? '',
          ]),
        },
      ],
    };
  };

  return (
    <div className="page-container">
      <div className="print:hidden">
        <PageHeader
          title="Appointments & Bookings"
          subtitle="Self-service vs staff bookings, cancellations, no-shows, lead time, utilisation, ETA accuracy"
          breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Reports', href: '/reports' }, { label: 'Appointments & Bookings' }]}
          actions={
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => { const t = document.title; document.title = `Berts-Appointments-${startDate}_to_${endDate}`; window.print(); document.title = t; }} className="btn-secondary text-xs">Print Report</button>
              <ExportMenu build={buildExport} disabled={!r} />
            </div>
          }
        />
        <div className="card p-3 mb-5 sticky top-0 z-20">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5 overflow-x-auto">
              {PRESETS.map((p) => (
                <button key={p.key} onClick={() => { const range = presetRange(p.key); setStartDate(range.start); setEndDate(range.end); setPreset(p.key); }}
                  className={`rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors ${preset === p.key ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                  {p.label}
                </button>
              ))}
            </div>
            <input type="date" value={startDate} max={endDate} onChange={(e) => { setStartDate(e.target.value); setPreset('CUSTOM'); }} className="input-field w-auto text-xs" aria-label="From" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" value={endDate} min={startDate} onChange={(e) => { setEndDate(e.target.value); setPreset('CUSTOM'); }} className="input-field w-auto text-xs" aria-label="To" />
          </div>
        </div>
      </div>

      {q.isLoading && <LoadingState message="Building the report..." />}
      {q.isError && <div className="card p-6 text-center border-red-200 bg-red-50"><p className="text-sm text-red-700">Failed to load the report.</p></div>}

      {r && (
        <div className="max-w-5xl">
          <div className="mb-4 border-b-2 border-slate-800 pb-3">
            <h1 className="text-xl font-bold text-slate-900">{r.meta.title}</h1>
            <p className="text-sm text-slate-600">{r.meta.organisation}{r.meta.siteName ? ` · ${r.meta.siteName}` : ''} · Period {r.meta.period.start} to {r.meta.period.end} ({r.meta.period.days} days)</p>
            <p className="text-xs text-slate-400">Generated {new Date(r.meta.generatedAt).toLocaleString()}{r.meta.generatedBy ? ` by ${r.meta.generatedBy}` : ''} · capacity {r.meta.definitions.capacity} position(s) · planned {r.meta.definitions.defaultDurationMinutes} min</p>
          </div>

          {!r.hasData && <div className="card p-6 text-center text-sm text-slate-500">No appointments in this period.</div>}

          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Bookings</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Kpi label="Total appointments" value={String(r.totals.total)} sub={`${r.totals.staffCreated} staff · ${r.totals.selfService} self-service`} />
              <Kpi label="Self-service share" value={pct(r.totals.selfServiceRate)} />
              <Kpi label="Cancellation rate" value={pct(r.totals.cancellationRate)} sub={`${r.totals.cancelled} cancelled`} />
              <Kpi label="Reschedule rate" value={pct(r.totals.rescheduleRate)} sub={`${r.totals.rescheduled} moved`} />
              <Kpi label="No-show rate" value={pct(r.totals.noShowRate)} sub={`${r.totals.missed} missed · ${r.totals.checkedIn} checked in`} />
              <Kpi label="Booking lead time" value={hrs(r.totals.leadTimeMedianHours)} sub={`p90 ${hrs(r.totals.leadTimeP90Hours)}`} />
              <Kpi label="On-time service starts" value={pct(r.totals.onTimeStartRate)} sub={`${r.totals.onTimeStarts} of ${r.totals.started} started (≤ +${r.meta.definitions.onTimeStartLateMinutes} min)`} />
              <Kpi label="Utilisation" value={pct(r.totals.utilisationRate)} sub={`${r.totals.bookedMinutes} of ${r.totals.capacityMinutes} min · ${r.totals.availableCapacityMinutes} min free`} />
            </div>
          </section>

          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Estimated vs actual completion</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Kpi label="Jobs measured" value={String(r.totals.etaVariance.count)} />
              <Kpi label="Median |Δ| vs published ETA" value={mins(r.totals.etaVariance.medianAbsMinutes)} sub={`p90 ${mins(r.totals.etaVariance.p90AbsMinutes)}`} />
              <Kpi label="Median Δ (signed)" value={mins(r.totals.etaVariance.medianSignedMinutes)} sub="+ = finished later than estimated" />
              <Kpi label="Median |Δ| vs plan" value={mins(r.totals.plannedVariance.medianAbsMinutes)} sub={`scheduled start + planned · p90 ${mins(r.totals.plannedVariance.p90AbsMinutes)}`} />
            </div>
          </section>

          {r.byDay.length > 1 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-slate-900">By day</h2>
              <div className="table-container">
                <table className="w-full text-sm">
                  <thead className="table-header"><tr><th>Date</th><th className="text-right">Total</th><th className="text-right">Self-service</th><th className="text-right">Cancelled</th><th className="text-right">Missed</th><th className="text-right">Checked in</th><th className="text-right">Booked / capacity (min)</th></tr></thead>
                  <tbody>
                    {r.byDay.map((d) => (
                      <tr key={d.date} className="table-row">
                        <td>{d.date}</td><td className="text-right tabular-nums">{d.total}</td><td className="text-right tabular-nums">{d.selfService}</td>
                        <td className="text-right tabular-nums">{d.cancelled}</td><td className="text-right tabular-nums">{d.missed}</td><td className="text-right tabular-nums">{d.checkedIn}</td>
                        <td className="text-right tabular-nums">{d.bookedMinutes} / {d.capacityMinutes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {r.rows.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-slate-900">Appointments <span className="font-normal text-slate-400">({r.rows.length}{r.rows.length > 200 ? ' — first 200 shown; CSV has all' : ''})</span></h2>
              <div className="table-container">
                <table className="w-full text-xs">
                  <thead className="table-header"><tr><th>Reference</th><th>Scheduled</th><th>Source</th><th>Status</th><th>Customer #</th><th>Services</th><th className="text-right">Lead (h)</th><th className="text-right">On time</th><th className="text-right">Est. done</th><th className="text-right">Actual</th><th className="text-right">Δ min</th></tr></thead>
                  <tbody>
                    {r.rows.slice(0, 200).map((x) => (
                      <tr key={x.id} className="table-row">
                        <td className="font-mono">{x.appointmentNumber ?? x.id.slice(0, 8)}</td>
                        <td>{fmtDT(x.scheduledStartAt)}</td>
                        <td>{x.source === 'SELF_SERVICE' ? <span className="badge bg-blue-50 text-blue-700">Self-service</span> : 'Staff'}</td>
                        <td>{x.status}</td>
                        <td className="font-mono">{x.customerNumber}</td>
                        <td className="max-w-[220px] truncate" title={x.services.join(', ')}>{x.services.join(', ')}</td>
                        <td className="text-right tabular-nums">{x.leadHours}</td>
                        <td className="text-right">{x.onTime == null ? '—' : x.onTime ? 'Yes' : 'No'}</td>
                        <td className="text-right">{fmtDT(x.estimatedCompletionAt)}</td>
                        <td className="text-right">{fmtDT(x.actualCompletionAt)}</td>
                        <td className={`text-right tabular-nums ${x.varianceMinutes != null && x.varianceMinutes > 15 ? 'text-rose-600' : ''}`}>{x.varianceMinutes ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="hidden print:block text-[10px] text-slate-500 border-t border-slate-300 pt-2 mt-4">
            Generated {new Date(r.meta.generatedAt).toLocaleString()}{r.meta.generatedBy ? ` by ${r.meta.generatedBy}` : ''} · Internal Management Use
          </div>
          <p className="print:hidden mt-6 text-xs text-slate-400"><Link href="/reports" className="text-blue-600 hover:underline">← All reports</Link></p>
        </div>
      )}
    </div>
  );
}
