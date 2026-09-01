'use client';

/**
 * Reports — unified manager view (CR-2026-043).
 * Merges the operational KPIs with the Rework / First-Time-Fix quality metrics
 * (previously a standalone /reports/rework page) into one page with a shared
 * date range. Service Mix and Due-for-Contact remain their own pages and are
 * linked at the bottom. The old Historical Analytics page is retired.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { useAuth } from '../../../hooks/use-auth';
import { PageHeader } from '../../../components/ui/page-header';
import { StatCard } from '../../../components/ui/stat-card';
import { LoadingState } from '../../../components/ui/loading-state';
import { EmptyState } from '../../../components/ui/empty-state';
import { ExportMenu } from '../../../components/ui/export-menu';
import type { ExportDocument } from '../../../lib/export';

const ALLOWED_ROLES = ['ADMIN'];

interface KpiMetric {
  code: string;
  name: string;
  value: number | string | null;
  target: string | null;
}

interface ReworkItem {
  id: string;
  serviceOrderId: string;
  reasonCode: string;
  description: string | null;
  reworkCount: number;
  openedAt: string;
  closedAt: string | null;
  customerName: string;
  vehiclePlate: string;
  primaryTechnician: string | null;
}
interface ReworkReport {
  summary: { totalOrders: number; reworkedOrders: number; reworkRate: number; firstTimeFixRate: number };
  items: ReworkItem[];
}

/**
 * CR-2026-100 — the Job Times report payload. One response carries BOTH time
 * bases and the waiting breakdown, so the on-screen toggle and the printed
 * report are always the same calculation.
 */
interface JobTimesJob {
  orderId: string;
  status: string;
  ticketNumber: string | null;
  visitNumber: string | null;
  customerName: string;
  plate: string;
  vehicleClass: string | null;
  sourceType: string;
  services: string[];
  technicians: Array<{ technicianId: string; name: string }>;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number;
  techWorkMs: number;
  waitingPartsMs: number;
  waitingCustomerMs: number;
  otherPausedMs: number;
}
interface JobTimesReport {
  jobs: JobTimesJob[];
  byTechnician: Array<{
    technicianId: string;
    name: string;
    employeeCode: string;
    jobsAssigned: number;
    jobsCompleted: number;
    productiveMs: number;
    heldMs: number;
    elapsedMs: number;
  }>;
  summary: {
    jobsTotal: number;
    jobsCompleted: number;
    jobsLive: number;
    totalElapsedMs: number;
    totalTechWorkMs: number;
    totalWaitingPartsMs: number;
    totalWaitingCustomerMs: number;
    totalOtherPausedMs: number;
    avgElapsedMs: number;
    avgTechWorkMs: number;
  };
}

type TimeBasis = 'ELAPSED' | 'TECH_WORK';

function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

const VEHICLE_CLASS_LABEL: Record<string, string> = {
  SEDAN_CLASS: 'Sedan',
  SUV_CLASS: 'SUV',
  UNKNOWN_REQUIRES_REVIEW: 'Unclassified',
};

function kpiColor(code: string): 'blue' | 'green' | 'amber' | 'red' | 'slate' {
  const c = code.toLowerCase();
  if (c.includes('completed') || c.includes('on_time') || c.includes('success')) return 'green';
  if (c.includes('blocked') || c.includes('missed') || c.includes('error') || c.includes('overdue')) return 'red';
  if (c.includes('wait') || c.includes('late') || c.includes('pending') || c.includes('avg')) return 'amber';
  return 'blue';
}

// Local (not UTC) date string so the range matches the operator's calendar day.
function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISO(d);
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const PRESETS: Array<{ label: string; days: number }> = [
  { label: 'Today', days: 0 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
    </div>
  );
}

export default function ReportsPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');
  const today = localISO(new Date());

  // Default to a recent window so both KPIs and rework show meaningful data.
  const [startDate, setStartDate] = useState(daysAgo(30));
  const [endDate, setEndDate] = useState(today);

  const activePreset = PRESETS.find((p) => daysAgo(p.days) === startDate && endDate === today)?.days ?? null;

  const kpiQuery = useQuery({
    queryKey: ['kpis', siteId, startDate, endDate],
    queryFn: () => api.get<KpiMetric[]>(`/reports/kpis?siteId=${siteId}&startDate=${startDate}&endDate=${endDate}`),
    enabled: allowed && !!siteId,
  });

  const reworkQuery = useQuery<ReworkReport>({
    queryKey: ['rework-report', siteId, startDate, endDate],
    queryFn: () => {
      const params = new URLSearchParams({ siteId, from: startDate, to: endDate });
      return api.get<ReworkReport>(`/reports/rework?${params.toString()}`);
    },
    enabled: allowed && !!siteId,
  });

  // CR-2026-100 §12–§15 — Job Times: elapsed vs technician work time.
  const [timeBasis, setTimeBasis] = useState<TimeBasis>('ELAPSED');
  const [filterTechId, setFilterTechId] = useState('');
  const [filterVehicleClass, setFilterVehicleClass] = useState('');
  const [filterSource, setFilterSource] = useState('');

  const techniciansQuery = useQuery<Array<{ id: string; employeeCode: string; userAccount: { fullName: string } }>>({
    queryKey: ['technicians', siteId],
    queryFn: () => api.get(`/technicians?siteId=${siteId}`),
    enabled: allowed && !!siteId,
  });

  const jobTimesQuery = useQuery<JobTimesReport>({
    queryKey: ['job-times', siteId, startDate, endDate, filterTechId, filterVehicleClass, filterSource],
    queryFn: () => {
      const params = new URLSearchParams({ siteId, startDate, endDate });
      if (filterTechId) params.set('technicianId', filterTechId);
      if (filterVehicleClass) params.set('vehicleClass', filterVehicleClass);
      if (filterSource) params.set('sourceType', filterSource);
      return api.get<JobTimesReport>(`/reports/job-times?${params.toString()}`);
    },
    enabled: allowed && !!siteId,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Reports" subtitle="Performance & quality" />
        <div className="card p-6 text-center border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">You do not have permission to view this report.</p>
        </div>
      </div>
    );
  }

  const kpis = kpiQuery.data;
  const rework = reworkQuery.data;

  const buildExport = (): ExportDocument | null => {
    if (!kpis && !rework) return null;
    const sections: ExportDocument['sections'] = [];
    if (kpis && kpis.length > 0) {
      sections.push({
        heading: 'Key performance indicators',
        columns: ['Metric', 'Value', 'Target'],
        rows: kpis.map((k) => [k.name, k.value !== null ? String(k.value) : '--', k.target ?? '']),
      });
    }
    if (rework) {
      sections.push({
        heading: 'Rework / First-Time-Fix summary',
        columns: ['Metric', 'Value'],
        rows: [
          ['First-Time-Fix rate', `${rework.summary.firstTimeFixRate}%`],
          ['Rework rate', `${rework.summary.reworkRate}%`],
          ['Reworked orders', rework.summary.reworkedOrders],
          ['Total orders', rework.summary.totalOrders],
        ],
      });
      if (rework.items.length > 0) {
        sections.push({
          heading: 'Rework detail — jobs that came back',
          columns: ['Opened', 'Customer', 'Vehicle', 'Reason', 'Description', 'Times back', 'Primary tech', 'Status'],
          rows: rework.items.map((r) => [
            fmtDate(r.openedAt),
            r.customerName || '',
            r.vehiclePlate || '',
            r.reasonCode,
            r.description || '',
            r.reworkCount,
            r.primaryTechnician ?? '',
            r.closedAt ? `Closed ${fmtDate(r.closedAt)}` : 'Open',
          ]),
        });
      }
    }
    return {
      title: 'Reports',
      filename: `reports_${startDate}_${endDate}`,
      subtitle: 'Operational KPIs and rework / first-time-fix quality',
      meta: [['Range', `${startDate} to ${endDate}`]],
      sections,
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Reports"
        subtitle="Operational KPIs and service quality at a glance"
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Reports' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => { setStartDate(daysAgo(p.days)); setEndDate(today); }}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    activePreset === p.days ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className="input-field w-auto" aria-label="From" />
            <span className="text-sm text-slate-400">to</span>
            <input type="date" value={endDate} min={startDate} max={today} onChange={(e) => setEndDate(e.target.value)} className="input-field w-auto" aria-label="To" />
            <ExportMenu build={buildExport} disabled={!kpis && !rework} />
            {/* CR-2026-100 §16 — a print-optimised report straight from the browser
                (Print / Save as PDF). The printed figures ARE the on-screen
                figures: same queries, same filters, same calculation. */}
            <button onClick={() => window.print()} className="btn-primary text-sm px-3 py-1.5">
              Print Report
            </button>
          </div>
        }
      />

      {/* CR-2026-100 §16 — management-ready letterhead, print only. */}
      <div className="hidden print:block mb-6 border-b-2 border-slate-800 pb-3">
        <div className="flex items-center justify-between">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/berts-logo.png" alt="Bert's Auto Parts Service Centre" className="h-12" />
          <div className="text-right">
            <h1 className="text-lg font-bold text-slate-900">Operations &amp; Job Times Report</h1>
            <p className="text-xs text-slate-600">Bert&apos;s Auto Parts Service Centre</p>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-slate-600 flex flex-wrap gap-x-5 gap-y-0.5">
          <span><b>Period:</b> {startDate} to {endDate}</span>
          <span>
            <b>Time basis:</b> {timeBasis === 'ELAPSED' ? 'Elapsed time (start to finish, holds included)' : 'Technician work time (labour only)'}
          </span>
          {filterTechId && (
            <span>
              <b>Technician:</b>{' '}
              {techniciansQuery.data?.find((t) => t.id === filterTechId)?.userAccount.fullName ?? filterTechId}
            </span>
          )}
          {filterVehicleClass && <span><b>Vehicle type:</b> {VEHICLE_CLASS_LABEL[filterVehicleClass] ?? filterVehicleClass}</span>}
          {filterSource && <span><b>Source:</b> {filterSource === 'APPOINTMENT' ? 'Appointments' : 'Walk-ins'}</span>}
          <span><b>Generated:</b> {new Date().toLocaleString()}</span>
        </div>
      </div>

      {/* ---- Operations KPIs ---- */}
      <section className="mb-8">
        <SectionHeading title="Operations" description="Throughput and appointment performance for the selected range." />
        {kpiQuery.isLoading && <LoadingState message="Loading KPIs..." />}
        {kpiQuery.isError && (
          <div className="card p-6 text-center border-red-200 bg-red-50">
            <p className="text-sm text-red-700">
              Failed to load KPIs.
              {kpiQuery.error instanceof Error ? ` ${kpiQuery.error.message}` : ''}
            </p>
          </div>
        )}
        {kpis && kpis.length === 0 && (
          <EmptyState title="No KPI data" description="Try a wider date range." />
        )}
        {kpis && kpis.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {kpis.map((kpi) => (
              <StatCard
                key={kpi.code}
                value={kpi.value !== null ? String(kpi.value) : '--'}
                label={kpi.name}
                color={kpiColor(kpi.code)}
                icon={kpi.target ? <span className="text-xs font-medium text-slate-400">Target: {kpi.target}</span> : undefined}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---- CR-2026-100 — Job Times: elapsed vs technician work time ---- */}
      <section className="mb-8" style={{ breakInside: 'avoid' }}>
        <SectionHeading
          title="Job Times"
          description="Two different questions: how long did the job take start to finish (elapsed), and how much technician labour was actually spent (work time). The breakdown explains the difference."
        />

        {/* Filters + time basis (§14) — hidden in print; the letterhead states them. */}
        <div className="flex flex-wrap items-center gap-2 mb-3 print:hidden">
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5" role="group" aria-label="Time basis">
            <button
              onClick={() => setTimeBasis('ELAPSED')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${timeBasis === 'ELAPSED' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              Elapsed Time
            </button>
            <button
              onClick={() => setTimeBasis('TECH_WORK')}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${timeBasis === 'TECH_WORK' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              Technician Work Time
            </button>
          </div>
          <select value={filterTechId} onChange={(e) => setFilterTechId(e.target.value)} className="input-field text-xs w-auto" aria-label="Technician">
            <option value="">All technicians</option>
            {(techniciansQuery.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.employeeCode} — {t.userAccount.fullName}</option>
            ))}
          </select>
          <select value={filterVehicleClass} onChange={(e) => setFilterVehicleClass(e.target.value)} className="input-field text-xs w-auto" aria-label="Vehicle type">
            <option value="">All vehicle types</option>
            <option value="SEDAN_CLASS">Sedan</option>
            <option value="SUV_CLASS">SUV</option>
          </select>
          <select value={filterSource} onChange={(e) => setFilterSource(e.target.value)} className="input-field text-xs w-auto" aria-label="Source">
            <option value="">Appointments + walk-ins</option>
            <option value="APPOINTMENT">Appointments only</option>
            <option value="WALKIN">Walk-ins only</option>
          </select>
        </div>

        {jobTimesQuery.isLoading && <LoadingState message="Loading job times..." />}
        {jobTimesQuery.isError && (
          <div className="card p-6 text-center border-red-200 bg-red-50">
            <p className="text-sm text-red-700">
              Failed to load job times.
              {jobTimesQuery.error instanceof Error ? ` ${jobTimesQuery.error.message}` : ''}
            </p>
          </div>
        )}
        {jobTimesQuery.data && (() => {
          const jt = jobTimesQuery.data;
          const s = jt.summary;
          const basisLabel = timeBasis === 'ELAPSED' ? 'Elapsed' : 'Tech Work';
          return (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <StatCard value={s.jobsTotal} label={`Jobs Started (${s.jobsCompleted} done, ${s.jobsLive} live)`} color="blue" />
                <StatCard
                  value={fmtDur(timeBasis === 'ELAPSED' ? s.avgElapsedMs : s.avgTechWorkMs)}
                  label={`Avg per Completed Job — ${basisLabel}`}
                  color="amber"
                />
                <StatCard
                  value={fmtDur(timeBasis === 'ELAPSED' ? s.totalElapsedMs : s.totalTechWorkMs)}
                  label={`Total — ${basisLabel}`}
                  color="slate"
                />
                <StatCard value={fmtDur(s.totalWaitingPartsMs)} label="Total Waiting for Parts" color={s.totalWaitingPartsMs > 0 ? 'red' : 'slate'} />
              </div>

              {/* §15 — technician performance without assignment-count double-counting. */}
              {jt.byTechnician.length > 0 && (
                <div className="table-container mb-4" style={{ breakInside: 'avoid' }}>
                  <table className="w-full text-sm">
                    <thead className="table-header">
                      <tr>
                        <th>Technician</th>
                        <th className="text-center">Jobs Assigned</th>
                        <th className="text-center">Jobs Completed</th>
                        <th className="text-right">Productive Time</th>
                        <th className="text-right">Held / Waiting</th>
                        <th className="text-right">Elapsed Job Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jt.byTechnician.map((t) => (
                        <tr key={t.technicianId} className="table-row">
                          <td className="text-slate-700">{t.name} <span className="font-mono text-xs text-slate-400">{t.employeeCode}</span></td>
                          <td className="text-center tabular-nums">{t.jobsAssigned}</td>
                          <td className="text-center tabular-nums">{t.jobsCompleted}</td>
                          <td className="text-right tabular-nums font-semibold text-emerald-700">{fmtDur(t.productiveMs)}</td>
                          <td className="text-right tabular-nums text-amber-700">{fmtDur(t.heldMs)}</td>
                          <td className="text-right tabular-nums text-slate-600">{fmtDur(t.elapsedMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[11px] text-slate-400 px-2 py-1.5">
                    Productive time is the union of real labour intervals — one person can never total more than the clock,
                    however many jobs they hold. Two technicians genuinely working at once does count twice on the job.
                  </p>
                </div>
              )}

              {jt.jobs.length === 0 ? (
                <EmptyState title="No jobs in this range" description="No work was started in the selected period with these filters." />
              ) : (
                <div className="table-container">
                  <table className="w-full text-sm">
                    <thead className="table-header">
                      <tr>
                        <th>Ticket</th>
                        <th>Customer / Vehicle</th>
                        <th>Services</th>
                        <th>Technicians</th>
                        <th className={`text-right ${timeBasis === 'ELAPSED' ? 'text-blue-700' : ''}`}>Elapsed</th>
                        <th className={`text-right ${timeBasis === 'TECH_WORK' ? 'text-blue-700' : ''}`}>Tech Work</th>
                        <th className="text-right">Waiting Parts</th>
                        <th className="text-right">Waiting Customer</th>
                        <th className="text-right">Other Paused</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jt.jobs.map((j) => (
                        <tr key={j.orderId} className="table-row">
                          <td className="font-mono text-xs text-blue-700 whitespace-nowrap">
                            {j.ticketNumber ?? '—'}
                            {j.visitNumber && <span className="block text-slate-400">{j.visitNumber}</span>}
                          </td>
                          <td className="text-slate-600">
                            {j.customerName}
                            <span className="block text-xs text-slate-400">
                              {j.plate}{j.vehicleClass ? ` · ${VEHICLE_CLASS_LABEL[j.vehicleClass] ?? ''}` : ''} · {j.sourceType === 'APPOINTMENT' ? 'Appt' : 'Walk-in'}
                            </span>
                          </td>
                          <td className="text-xs text-slate-600 max-w-[220px]">{j.services.join(', ')}</td>
                          <td className="text-xs text-slate-600">{j.technicians.map((t) => t.name).join(', ') || '—'}</td>
                          <td className={`text-right tabular-nums ${timeBasis === 'ELAPSED' ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>{fmtDur(j.elapsedMs)}</td>
                          <td className={`text-right tabular-nums ${timeBasis === 'TECH_WORK' ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>{fmtDur(j.techWorkMs)}</td>
                          <td className="text-right tabular-nums text-amber-700">{j.waitingPartsMs > 0 ? fmtDur(j.waitingPartsMs) : '—'}</td>
                          <td className="text-right tabular-nums text-amber-700">{j.waitingCustomerMs > 0 ? fmtDur(j.waitingCustomerMs) : '—'}</td>
                          <td className="text-right tabular-nums text-slate-500">{j.otherPausedMs > 0 ? fmtDur(j.otherPausedMs) : '—'}</td>
                          <td>
                            {j.completedAt
                              ? <span className="badge bg-emerald-50 text-emerald-700">Done</span>
                              : <span className="badge bg-blue-50 text-blue-700">Live</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        })()}
      </section>

      {/* ---- Quality: Rework / First-Time-Fix ---- */}
      <section className="mb-8">
        <SectionHeading
          title="Quality — Rework & First-Time-Fix"
          description="Jobs that came back because the work wasn't right the first time."
        />
        {reworkQuery.isLoading && <LoadingState message="Loading rework metrics..." />}
        {reworkQuery.isError && (
          <div className="card p-6 text-center border-red-200 bg-red-50">
            <p className="text-sm text-red-700">
              Failed to load rework metrics.
              {reworkQuery.error instanceof Error ? ` ${reworkQuery.error.message}` : ''}
            </p>
          </div>
        )}
        {rework && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <StatCard value={`${rework.summary.firstTimeFixRate}%`} label="First-Time-Fix Rate" color="green" />
              <StatCard value={`${rework.summary.reworkRate}%`} label="Rework Rate" color="red" />
              <StatCard value={rework.summary.reworkedOrders} label="Reworked Orders" color="amber" />
              <StatCard value={rework.summary.totalOrders} label="Total Orders" color="blue" />
            </div>

            {rework.items.length === 0 ? (
              <EmptyState title="No rework on record" description="No jobs came back for re-service in the selected range." />
            ) : (
              <div className="table-container">
                <table className="w-full text-sm">
                  <thead className="table-header">
                    <tr>
                      <th>Opened</th>
                      <th>Customer</th>
                      <th>Vehicle</th>
                      <th>Reason</th>
                      <th className="text-center">Times back</th>
                      <th>Primary tech</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rework.items.map((r) => (
                      <tr key={r.id} className="table-row">
                        <td className="text-slate-700 whitespace-nowrap">{fmtDate(r.openedAt)}</td>
                        <td className="text-slate-600">{r.customerName || '—'}</td>
                        <td className="text-slate-600 font-mono text-xs">{r.vehiclePlate || '—'}</td>
                        <td className="text-slate-600">
                          <span className="font-medium">{r.reasonCode}</span>
                          {r.description && <span className="block text-xs text-slate-400 truncate max-w-[260px]" title={r.description}>{r.description}</span>}
                        </td>
                        <td className="text-center tabular-nums font-semibold text-red-600">{r.reworkCount}</td>
                        <td className="text-slate-600">{r.primaryTechnician ?? '—'}</td>
                        <td>
                          {r.closedAt
                            ? <span className="badge bg-emerald-50 text-emerald-700">Closed {fmtDate(r.closedAt)}</span>
                            : <span className="badge bg-amber-50 text-amber-700">Open</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {/* ---- More reports ---- */}
      <section className="print:hidden">
        <SectionHeading title="More reports" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Link href="/reports/service-mix" className="card p-4 hover:border-blue-300 hover:shadow-sm transition-all">
            <h3 className="text-sm font-semibold text-slate-900">Service Mix</h3>
            <p className="text-xs text-slate-500 mt-1">Volume and revenue by service family.</p>
          </Link>
          <Link href="/reports/due-for-contact" className="card p-4 hover:border-blue-300 hover:shadow-sm transition-all">
            <h3 className="text-sm font-semibold text-slate-900">Due for Contact</h3>
            <p className="text-xs text-slate-500 mt-1">Customers due for a maintenance follow-up.</p>
          </Link>
        </div>
      </section>
    </div>
  );
}
