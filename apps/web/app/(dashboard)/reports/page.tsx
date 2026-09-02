'use client';

/**
 * CR-2026-104 — the Service Center Performance Report.
 *
 * Two clear areas (§34): REPORT CONTROLS (dates, filters, comparison, time
 * basis, print, export) and THE REPORT — a management document, not a
 * dashboard screenshot. Everything renders ONE server payload
 * (`/reports/performance-report`), so screen, print and CSV always reconcile
 * (§25). Printing uses the browser's Save-as-PDF with an intentional print
 * layout (§21–§23) and a §32 file name via document.title.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api-client';
import { useSiteId } from '../../../hooks/use-site';
import { useAuth } from '../../../hooks/use-auth';
import { PageHeader } from '../../../components/ui/page-header';
import { LoadingState } from '../../../components/ui/loading-state';
import { ExportMenu } from '../../../components/ui/export-menu';
import type { ExportDocument } from '../../../lib/export';

const ALLOWED_ROLES = ['ADMIN'];

type TimeBasis = 'ELAPSED' | 'TECH_WORK';

/* ---------------- formatting (§28 — no fake precision) ---------------- */
function fmtDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0m';
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 10) / 10}%`);
function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/* ---------------- payload types (mirrors the server model) ---------------- */
interface Cmp { value: number; prev: number | null; diff: number | null; pct: number | null }
interface Report {
  meta: {
    title: string;
    organisation: string;
    period: { start: string; end: string; days: number };
    comparePeriod: { start: string; end: string } | null;
    generatedAt: string;
    generatedBy: string | null;
    filters: { technicianId: string | null; vehicleClass: string | null; sourceType: string | null; serviceTypeId: string | null };
    thresholds: Record<string, number>;
  };
  summary: {
    vehiclesServiced: Cmp; jobsStarted: Cmp; jobsCompleted: Cmp;
    avgElapsedMs: Cmp; avgTechWorkMs: Cmp;
    medianElapsedMs: number; medianTechWorkMs: number; maxElapsedMs: number; maxTechWorkMs: number;
    avgWaitMinutes: Cmp; waitingPartsJobs: Cmp; waitingPartsPct: number; waitingCustomerJobs: number;
    reworkRate: Cmp; appointments: Cmp; walkIns: Cmp;
  };
  flow: { appointments: number; walkIns: number; totalArrivals: number; jobsStarted: number; jobsCompleted: number; visitsCompleted: number; readyForPickup: number; missedAppointments: number; cancelledVisits: number };
  sourceComparison: {
    appointment: { vehicles: number; jobs: number; jobsCompleted: number; completionRate: number; avgElapsedMs: number; avgTechWorkMs: number; noShowRate: number };
    walkIn: { vehicles: number; jobs: number; jobsCompleted: number; completionRate: number; avgElapsedMs: number; avgTechWorkMs: number };
  };
  vehicleTypes: Array<{ vehicleClass: string; vehicles: number; jobs: number; avgElapsedMs: number; avgTechWorkMs: number }>;
  technicians: Array<{
    technicianId: string; name: string; employeeCode: string;
    jobsAssigned: number; jobsCompleted: number; productiveMs: number; avgWorkPerCompletedMs: number;
    heldJobs: number; reworkCount: number;
    jobs: Array<{ orderId: string; plate: string; visitNumber: string | null; serviceVisitId: string; services: string[]; status: string; elapsedMs: number; techWorkMs: number; waitingPartsMs: number }>;
  }>;
  delays: Array<{ type: string; jobsAffected: number; totalMs: number; avgMs: number; medianMs: number; maxMs: number }>;
  parts: { jobsAffected: number; totalMs: number; avgMs: number; medianMs: number; maxMs: number; pctOfVehicles: number; currentlyWaiting: number; jobs: Array<{ orderId: string; plate: string; visitNumber: string | null; services: string[]; waitingPartsMs: number; status: string }> };
  quality: { jobsSentToQc: number; reworkedOrders: number; reworkRate: number; firstTimeFixRate: number; eligibleOrders: number; currentlyInRework: number };
  serviceTypes: { note: string; multiServiceJobs: number; rows: Array<{ code: string; name: string; volume: number; targetMinutes: number; avgElapsedMs: number; avgTechWorkMs: number; varianceElapsedMs: number; varianceTechWorkMs: number }> };
  trend: Array<{ date: string; arrivals: number; jobsStarted: number; jobsCompleted: number; avgElapsedMs: number; avgTechWorkMs: number; partsDelayMs: number }>;
  attention: Array<{ kind: string; threshold: string; label: string; detail: string; orderId?: string }>;
  hasData: boolean;
}

/* ---------------- small presentation pieces ---------------- */
function Delta({ c, invert = false, unit = '' }: { c: Cmp; invert?: boolean; unit?: string }) {
  if (c.prev === null || c.diff === null) return null;
  if (c.diff === 0) return <span className="text-[11px] text-slate-400">no change vs previous</span>;
  const up = c.diff > 0;
  const good = invert ? !up : up;
  return (
    <span className={`text-[11px] font-medium ${good ? 'text-emerald-700' : 'text-red-600'}`}>
      {up ? '▲' : '▼'} {c.pct != null ? `${Math.abs(c.pct)}%` : `${Math.abs(c.diff)}${unit}`} vs previous
    </span>
  );
}

function KpiCard({ label, value, delta, sub }: { label: string; value: string | number; delta?: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5" style={{ breakInside: 'avoid' }}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-xl font-bold text-slate-900 tabular-nums leading-tight">{value}</div>
      {delta}
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

function ReportSection({ title, children, breakBefore = false }: { title: string; children: React.ReactNode; breakBefore?: boolean }) {
  return (
    <section className="mb-6" style={breakBefore ? { breakBefore: 'page' } : undefined}>
      <h2 className="text-sm font-bold text-slate-900 border-b-2 border-slate-800 pb-1 mb-3">{title}</h2>
      {children}
    </section>
  );
}

/** §17 — a small honest line chart. Grayscale-safe, no decoration. */
function MiniLine({ points, format, color = '#334155' }: { points: Array<{ x: string; y: number }>; format: (v: number) => string; color?: string }) {
  if (points.length < 2) return null;
  const W = 640; const H = 110; const P = 6;
  const maxY = Math.max(...points.map((p) => p.y), 1);
  const px = (i: number) => P + (i * (W - 2 * P)) / (points.length - 1);
  const py = (v: number) => H - P - (v / maxY) * (H - 2 * P);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(i)},${py(p.y)}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 120 }}>
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="#e2e8f0" strokeWidth={1} />
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={px(i)} cy={py(p.y)} r={2.2} fill={color} />
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400">
        <span>{fmtDay(points[0].x)}</span>
        <span>peak {format(maxY)}</span>
        <span>{fmtDay(points[points.length - 1].x)}</span>
      </div>
    </div>
  );
}

/** §17 — a small bar chart for daily counts. */
function MiniBars({ points }: { points: Array<{ x: string; y: number }> }) {
  if (points.length === 0) return null;
  const W = 640; const H = 90; const P = 4;
  const maxY = Math.max(...points.map((p) => p.y), 1);
  const bw = (W - 2 * P) / points.length;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 100 }}>
        {points.map((p, i) => {
          const h = (p.y / maxY) * (H - 2 * P);
          return <rect key={i} x={P + i * bw + 1} y={H - P - h} width={Math.max(bw - 2, 1)} height={h} fill="#475569" />;
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400">
        <span>{fmtDay(points[0].x)}</span>
        <span>peak {maxY}</span>
        <span>{fmtDay(points[points.length - 1].x)}</span>
      </div>
    </div>
  );
}

const VEHICLE_CLASS_LABEL: Record<string, string> = {
  SEDAN_CLASS: 'Sedan',
  SUV_CLASS: 'SUV',
  UNCLASSIFIED: 'Unclassified',
};
const DELAY_LABEL: Record<string, string> = {
  WAITING_PARTS: 'Waiting for Parts',
  WAITING_CUSTOMER: 'Waiting for Customer',
  OTHER_PAUSED: 'Other Paused Time',
};

/* ---------------- date presets (§19) ---------------- */
function presetRange(key: string): { start: string; end: string } {
  const now = new Date();
  const day = (d: Date) => localISO(d);
  const shift = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const monday = (d: Date) => shift(d, -((d.getDay() + 6) % 7));
  switch (key) {
    case 'TODAY': return { start: day(now), end: day(now) };
    case 'YESTERDAY': return { start: day(shift(now, -1)), end: day(shift(now, -1)) };
    case 'THIS_WEEK': return { start: day(monday(now)), end: day(now) };
    case 'LAST_WEEK': return { start: day(shift(monday(now), -7)), end: day(shift(monday(now), -1)) };
    case 'THIS_MONTH': return { start: day(new Date(now.getFullYear(), now.getMonth(), 1)), end: day(now) };
    case 'LAST_MONTH': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: day(first), end: day(last) };
    }
    default: return { start: day(shift(now, -29)), end: day(now) };
  }
}
const PRESETS = [
  { key: 'TODAY', label: 'Today' },
  { key: 'YESTERDAY', label: 'Yesterday' },
  { key: 'THIS_WEEK', label: 'This Week' },
  { key: 'LAST_WEEK', label: 'Last Week' },
  { key: 'THIS_MONTH', label: 'This Month' },
  { key: 'LAST_MONTH', label: 'Last Month' },
];

export default function ReportsPage() {
  const siteId = useSiteId();
  const { user } = useAuth();
  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');

  const defaultRange = presetRange('THIS_MONTH');
  const [startDate, setStartDate] = useState(defaultRange.start);
  const [endDate, setEndDate] = useState(defaultRange.end);
  const [preset, setPreset] = useState('THIS_MONTH');
  const [timeBasis, setTimeBasis] = useState<TimeBasis>('ELAPSED');
  const [compare, setCompare] = useState(false);
  const [filterTechId, setFilterTechId] = useState('');
  const [filterVehicleClass, setFilterVehicleClass] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterServiceTypeId, setFilterServiceTypeId] = useState('');

  const resetFilters = () => {
    const r = presetRange('THIS_MONTH');
    setStartDate(r.start); setEndDate(r.end); setPreset('THIS_MONTH');
    setTimeBasis('ELAPSED'); setCompare(false);
    setFilterTechId(''); setFilterVehicleClass(''); setFilterSource(''); setFilterServiceTypeId('');
  };

  const techniciansQuery = useQuery<Array<{ id: string; employeeCode: string; userAccount: { fullName: string } }>>({
    queryKey: ['technicians', siteId],
    queryFn: () => api.get(`/technicians?siteId=${siteId}`),
    enabled: allowed && !!siteId,
  });
  const serviceTypesQuery = useQuery<Array<{ id: string; code: string; name: string }>>({
    queryKey: ['service-types-report'],
    queryFn: () => api.get('/service-types'),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });

  const reportQuery = useQuery<Report>({
    queryKey: ['performance-report', siteId, startDate, endDate, filterTechId, filterVehicleClass, filterSource, filterServiceTypeId, compare],
    queryFn: () => {
      const params = new URLSearchParams({ siteId, startDate, endDate });
      if (filterTechId) params.set('technicianId', filterTechId);
      if (filterVehicleClass) params.set('vehicleClass', filterVehicleClass);
      if (filterSource) params.set('sourceType', filterSource);
      if (filterServiceTypeId) params.set('serviceTypeId', filterServiceTypeId);
      if (compare) params.set('compare', 'true');
      return api.get<Report>(`/reports/performance-report?${params.toString()}`);
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

  const r = reportQuery.data;
  // §5 — the selected basis picks which figure leads; both are always in the payload.
  const basis = (elapsed: number, work: number) => (timeBasis === 'ELAPSED' ? elapsed : work);
  const basisLabel = timeBasis === 'ELAPSED' ? 'Elapsed Time' : 'Technician Work Time';

  const techName = (id: string) =>
    techniciansQuery.data?.find((t) => t.id === id)?.userAccount.fullName ?? id;
  const activeFilterChips = r
    ? [
        r.meta.filters.technicianId ? `Technician: ${techName(r.meta.filters.technicianId)}` : null,
        r.meta.filters.vehicleClass ? `Vehicle: ${VEHICLE_CLASS_LABEL[r.meta.filters.vehicleClass] ?? r.meta.filters.vehicleClass}` : null,
        r.meta.filters.sourceType ? (r.meta.filters.sourceType === 'APPOINTMENT' ? 'Appointments only' : 'Walk-ins only') : null,
        r.meta.filters.serviceTypeId
          ? `Service: ${serviceTypesQuery.data?.find((s) => s.id === r.meta.filters.serviceTypeId)?.name ?? 'selected'}`
          : null,
      ].filter(Boolean) as string[]
    : [];

  // §21/§32 — print with a proper file name, restore afterwards.
  const printReport = () => {
    const prior = document.title;
    const scope = filterTechId ? 'Technician-Performance' : 'Performance';
    document.title = `Berts-Service-Center-${scope}-${startDate}_to_${endDate}`;
    window.print();
    setTimeout(() => { document.title = prior; }, 500);
  };

  // §31 — detail CSV from the SAME payload/filters as the report.
  const buildExport = (): ExportDocument | null => {
    if (!r) return null;
    const jobRows = new Map<string, Report['technicians'][number]['jobs'][number] & { technicians: string }>();
    for (const t of r.technicians) {
      for (const j of t.jobs) {
        const existing = jobRows.get(j.orderId);
        if (existing) existing.technicians += `; ${t.name}`;
        else jobRows.set(j.orderId, { ...j, technicians: t.name });
      }
    }
    return {
      title: 'Service Center Performance — detail',
      filename: `berts-performance-detail_${startDate}_to_${endDate}`,
      subtitle: `Period ${r.meta.period.start} to ${r.meta.period.end} · basis ${basisLabel}`,
      meta: [
        ['Filters', activeFilterChips.join(' · ') || 'none'],
        ['Generated', new Date(r.meta.generatedAt).toLocaleString()],
      ],
      sections: [
        {
          heading: 'Jobs (period detail)',
          columns: ['Plate', 'Visit', 'Services', 'Status', 'Technicians', 'Elapsed (min)', 'Tech work (min)', 'Waiting parts (min)'],
          rows: [...jobRows.values()].map((j) => [
            j.plate, j.visitNumber ?? '', j.services.join(' + '), j.status, j.technicians,
            Math.round(j.elapsedMs / 60000), Math.round(j.techWorkMs / 60000), Math.round(j.waitingPartsMs / 60000),
          ]),
        },
        {
          heading: 'Technicians',
          columns: ['Technician', 'Code', 'Jobs assigned', 'Jobs completed', 'Productive (min)', 'Avg work/completed (min)', 'Held jobs', 'Rework'],
          rows: r.technicians.map((t) => [
            t.name, t.employeeCode, t.jobsAssigned, t.jobsCompleted,
            Math.round(t.productiveMs / 60000), Math.round(t.avgWorkPerCompletedMs / 60000), t.heldJobs, t.reworkCount,
          ]),
        },
      ],
    };
  };

  // §4 — deterministic management summary from the data itself.
  const summaryParagraph = (() => {
    if (!r || !r.hasData) return null;
    const s = r.summary;
    const parts: string[] = [];
    parts.push(
      `During the reporting period, ${s.vehiclesServiced.value} vehicle${s.vehiclesServiced.value === 1 ? ' was' : 's were'} serviced and ${s.jobsCompleted.value} job${s.jobsCompleted.value === 1 ? ' was' : 's were'} completed.`,
    );
    if (s.jobsCompleted.value > 0) {
      parts.push(
        `Average elapsed service time was ${fmtDur(s.avgElapsedMs.value)} (median ${fmtDur(r.summary.medianElapsedMs)}), while average technician work time was ${fmtDur(s.avgTechWorkMs.value)}.`,
      );
    }
    if (s.waitingPartsJobs.value > 0) {
      parts.push(
        `Parts-related delays affected ${s.waitingPartsJobs.value} job${s.waitingPartsJobs.value === 1 ? '' : 's'} (${fmtPct(s.waitingPartsPct)} of serviced vehicles).`,
      );
    }
    if (r.quality.eligibleOrders > 0) {
      parts.push(`Rework occurred on ${fmtPct(s.reworkRate.value)} of orders in the period.`);
    }
    const nonZero = r.delays.filter((d) => d.totalMs > 0).sort((a, b) => b.totalMs - a.totalMs);
    if (nonZero.length > 0) {
      parts.push(
        `${DELAY_LABEL[nonZero[0].type]} was the largest recorded source of operational delay (${fmtDur(nonZero[0].totalMs)} in total).`,
      );
    }
    return parts.join(' ');
  })();

  return (
    <div className="page-container">
      {/* ================= REPORT CONTROLS (§34) — never printed ================= */}
      <div className="print:hidden">
        <PageHeader
          title="Reports"
          subtitle="Service Center Performance Report"
          breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Reports' }]}
        />
        <div className="card p-3 mb-5 sticky top-0 z-20 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5 overflow-x-auto">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => { const range = presetRange(p.key); setStartDate(range.start); setEndDate(range.end); setPreset(p.key); }}
                  className={`rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors ${preset === p.key ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input type="date" value={startDate} max={endDate} onChange={(e) => { setStartDate(e.target.value); setPreset('CUSTOM'); }} className="input-field w-auto text-xs" aria-label="From" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" value={endDate} min={startDate} onChange={(e) => { setEndDate(e.target.value); setPreset('CUSTOM'); }} className="input-field w-auto text-xs" aria-label="To" />
            <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer ml-1">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
              Compare previous period
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5" role="group" aria-label="Time basis">
              <button onClick={() => setTimeBasis('ELAPSED')} className={`rounded-md px-2.5 py-1 text-xs font-medium ${timeBasis === 'ELAPSED' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                Elapsed Time
              </button>
              <button onClick={() => setTimeBasis('TECH_WORK')} className={`rounded-md px-2.5 py-1 text-xs font-medium ${timeBasis === 'TECH_WORK' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
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
            <select value={filterServiceTypeId} onChange={(e) => setFilterServiceTypeId(e.target.value)} className="input-field text-xs w-auto" aria-label="Service">
              <option value="">All services</option>
              {(serviceTypesQuery.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button onClick={resetFilters} className="text-xs text-slate-500 hover:text-slate-700 underline">Reset Filters</button>
            <div className="ml-auto flex items-center gap-2">
              <ExportMenu build={buildExport} disabled={!r} />
              <button onClick={printReport} disabled={!r} className="btn-primary text-sm px-3 py-1.5">
                Print Report
              </button>
            </div>
          </div>
        </div>
      </div>

      {reportQuery.isLoading && <LoadingState message="Building the report..." />}
      {reportQuery.isError && (
        <div className="card p-6 text-center border-red-200 bg-red-50 print:hidden">
          <p className="text-sm text-red-700">
            Failed to build the report.
            {reportQuery.error instanceof Error ? ` ${reportQuery.error.message}` : ''}
          </p>
        </div>
      )}

      {/* ================= THE REPORT ================= */}
      {r && (
        <div className="max-w-4xl">
          {/* ---- Report header (§2/§23) — screen AND print ---- */}
          <div className="border-b-2 border-slate-800 pb-3 mb-5">
            <div className="flex items-start justify-between gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/berts-logo.png" alt="Bert's Service Center" className="h-12" />
              <div className="text-right">
                <h1 className="text-lg font-bold text-slate-900">{r.meta.title}</h1>
                <p className="text-xs text-slate-600">{r.meta.organisation}</p>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-slate-600 flex flex-wrap gap-x-5 gap-y-0.5">
              <span><b>Period:</b> {r.meta.period.start} to {r.meta.period.end} ({r.meta.period.days} day{r.meta.period.days === 1 ? '' : 's'})</span>
              {r.meta.comparePeriod && (
                <span><b>Compared with:</b> {r.meta.comparePeriod.start} to {r.meta.comparePeriod.end}</span>
              )}
              <span><b>Time basis:</b> {basisLabel}</span>
              <span><b>Filters:</b> {activeFilterChips.join(' · ') || 'none'}</span>
              <span><b>Generated:</b> {new Date(r.meta.generatedAt).toLocaleString()}{r.meta.generatedBy ? ` by ${r.meta.generatedBy}` : ''}</span>
            </div>
          </div>

          {!r.hasData ? (
            <div className="card p-8 text-center">
              <p className="text-sm text-slate-600">No records matched the selected reporting period and filters.</p>
              <p className="text-xs text-slate-400 mt-1">Widen the date range or clear filters.</p>
            </div>
          ) : (
            <>
              {/* ---- Page 1: Executive Summary (§3/§4) ---- */}
              <ReportSection title="Executive Summary">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <KpiCard label="Vehicles Serviced" value={r.summary.vehiclesServiced.value} delta={<Delta c={r.summary.vehiclesServiced} />} />
                  <KpiCard label="Jobs Completed" value={r.summary.jobsCompleted.value} delta={<Delta c={r.summary.jobsCompleted} />} />
                  <KpiCard
                    label={`Avg Service Time (${timeBasis === 'ELAPSED' ? 'elapsed' : 'tech work'})`}
                    value={fmtDur(basis(r.summary.avgElapsedMs.value, r.summary.avgTechWorkMs.value))}
                    delta={<Delta c={timeBasis === 'ELAPSED' ? r.summary.avgElapsedMs : r.summary.avgTechWorkMs} invert />}
                  />
                  <KpiCard label="Avg Queue Wait" value={`${r.summary.avgWaitMinutes.value}m`} delta={<Delta c={r.summary.avgWaitMinutes} invert unit="m" />} />
                  <KpiCard label="Waiting for Parts" value={r.summary.waitingPartsJobs.value} sub={`${fmtPct(r.summary.waitingPartsPct)} of vehicles`} delta={<Delta c={r.summary.waitingPartsJobs} invert />} />
                  <KpiCard label="Rework Rate" value={fmtPct(r.summary.reworkRate.value)} delta={<Delta c={r.summary.reworkRate} invert />} />
                  <KpiCard label="Appointments" value={r.summary.appointments.value} delta={<Delta c={r.summary.appointments} />} />
                  <KpiCard label="Walk-Ins" value={r.summary.walkIns.value} delta={<Delta c={r.summary.walkIns} />} />
                </div>
                {summaryParagraph && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Performance Summary</div>
                    <p className="text-sm text-slate-800 leading-relaxed">{summaryParagraph}</p>
                  </div>
                )}
              </ReportSection>

              {/* ---- Time performance (§5/§6): both bases, never renamed ---- */}
              <ReportSection title="Service Time — Elapsed vs Technician Work">
                <div className="table-container">
                  <table className="w-full text-sm">
                    <thead className="table-header">
                      <tr><th>Metric</th><th className="text-right">Elapsed</th><th className="text-right">Technician Work</th></tr>
                    </thead>
                    <tbody>
                      <tr className="table-row"><td>Average (completed jobs)</td><td className="text-right tabular-nums">{fmtDur(r.summary.avgElapsedMs.value)}</td><td className="text-right tabular-nums">{fmtDur(r.summary.avgTechWorkMs.value)}</td></tr>
                      <tr className="table-row"><td>Median</td><td className="text-right tabular-nums">{fmtDur(r.summary.medianElapsedMs)}</td><td className="text-right tabular-nums">{fmtDur(r.summary.medianTechWorkMs)}</td></tr>
                      <tr className="table-row"><td>Maximum</td><td className="text-right tabular-nums">{fmtDur(r.summary.maxElapsedMs)}</td><td className="text-right tabular-nums">{fmtDur(r.summary.maxTechWorkMs)}</td></tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  Elapsed includes measured operational holds (parts, customer, pauses); technician work is the
                  union of real labour intervals and can never exceed the clock.
                </p>
              </ReportSection>

              {/* ---- Page 2: Operational Performance (§7/§8/§9) ---- */}
              <ReportSection title="Operational Flow" breakBefore>
                <div className="flex flex-wrap items-center gap-1.5 text-sm mb-3">
                  {[
                    ['Arrivals', r.flow.totalArrivals],
                    ['Jobs Started', r.flow.jobsStarted],
                    ['Jobs Completed', r.flow.jobsCompleted],
                    ['Visits Closed', r.flow.visitsCompleted],
                    ['Ready for Pickup', r.flow.readyForPickup],
                  ].map(([label, value], i, arr) => (
                    <span key={label as string} className="flex items-center gap-1.5">
                      <span className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
                        <b className="tabular-nums">{value}</b> <span className="text-xs text-slate-500">{label}</span>
                      </span>
                      {i < arr.length - 1 && <span className="text-slate-300">→</span>}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-slate-500">
                  {r.flow.appointments} appointments · {r.flow.walkIns} walk-ins · {r.flow.missedAppointments} missed
                  appointment{r.flow.missedAppointments === 1 ? '' : 's'} · {r.flow.cancelledVisits} cancelled/abandoned
                  visit{r.flow.cancelledVisits === 1 ? '' : 's'}
                </p>
              </ReportSection>

              <ReportSection title="Appointments vs Walk-Ins">
                <div className="table-container">
                  <table className="w-full text-sm">
                    <thead className="table-header">
                      <tr><th>Source</th><th className="text-right">Vehicles</th><th className="text-right">Jobs</th><th className="text-right">Completed</th><th className="text-right">Completion</th><th className="text-right">Avg Elapsed</th><th className="text-right">Avg Tech Work</th><th className="text-right">No-Show</th></tr>
                    </thead>
                    <tbody>
                      <tr className="table-row">
                        <td>Appointments</td>
                        <td className="text-right tabular-nums">{r.sourceComparison.appointment.vehicles}</td>
                        <td className="text-right tabular-nums">{r.sourceComparison.appointment.jobs}</td>
                        <td className="text-right tabular-nums">{r.sourceComparison.appointment.jobsCompleted}</td>
                        <td className="text-right tabular-nums">{fmtPct(r.sourceComparison.appointment.completionRate)}</td>
                        <td className="text-right tabular-nums">{fmtDur(r.sourceComparison.appointment.avgElapsedMs)}</td>
                        <td className="text-right tabular-nums">{fmtDur(r.sourceComparison.appointment.avgTechWorkMs)}</td>
                        <td className="text-right tabular-nums">{fmtPct(r.sourceComparison.appointment.noShowRate)}</td>
                      </tr>
                      <tr className="table-row">
                        <td>Walk-Ins</td>
                        <td className="text-right tabular-nums">{r.sourceComparison.walkIn.vehicles}</td>
                        <td className="text-right tabular-nums">{r.sourceComparison.walkIn.jobs}</td>
                        <td className="text-right tabular-nums">{r.sourceComparison.walkIn.jobsCompleted}</td>
                        <td className="text-right tabular-nums">{fmtPct(r.sourceComparison.walkIn.completionRate)}</td>
                        <td className="text-right tabular-nums">{fmtDur(r.sourceComparison.walkIn.avgElapsedMs)}</td>
                        <td className="text-right tabular-nums">{fmtDur(r.sourceComparison.walkIn.avgTechWorkMs)}</td>
                        <td className="text-right text-slate-400">—</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </ReportSection>

              <ReportSection title="Vehicle Type Analysis">
                <div className="table-container">
                  <table className="w-full text-sm">
                    <thead className="table-header">
                      <tr><th>Vehicle Type</th><th className="text-right">Vehicles</th><th className="text-right">Jobs</th><th className="text-right">Avg Elapsed</th><th className="text-right">Avg Tech Work</th></tr>
                    </thead>
                    <tbody>
                      {r.vehicleTypes.map((v) => (
                        <tr key={v.vehicleClass} className="table-row">
                          <td>{VEHICLE_CLASS_LABEL[v.vehicleClass] ?? v.vehicleClass}</td>
                          <td className="text-right tabular-nums">{v.vehicles}</td>
                          <td className="text-right tabular-nums">{v.jobs}</td>
                          <td className="text-right tabular-nums">{fmtDur(v.avgElapsedMs)}</td>
                          <td className="text-right tabular-nums">{fmtDur(v.avgTechWorkMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ReportSection>

              {/* ---- Page 3: Time & Delay Analysis (§12/§13) ---- */}
              <ReportSection title="Operational Delays" breakBefore>
                <div className="table-container mb-3">
                  <table className="w-full text-sm">
                    <thead className="table-header">
                      <tr><th>Delay Type</th><th className="text-right">Jobs Affected</th><th className="text-right">Total</th><th className="text-right">Average</th><th className="text-right">Median</th><th className="text-right">Longest</th></tr>
                    </thead>
                    <tbody>
                      {r.delays.map((d) => (
                        <tr key={d.type} className="table-row">
                          <td>{DELAY_LABEL[d.type] ?? d.type}</td>
                          <td className="text-right tabular-nums">{d.jobsAffected}</td>
                          <td className="text-right tabular-nums">{fmtDur(d.totalMs)}</td>
                          <td className="text-right tabular-nums">{fmtDur(d.avgMs)}</td>
                          <td className="text-right tabular-nums">{fmtDur(d.medianMs)}</td>
                          <td className="text-right tabular-nums">{fmtDur(d.maxMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-slate-400 mb-3">
                  Operational delay is measured hold time on jobs — it is not technician productive time.
                </p>
                {r.parts.jobsAffected > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3" style={{ breakInside: 'avoid' }}>
                    <div className="text-xs font-bold text-amber-900 mb-1.5">
                      Waiting for Parts — {r.parts.jobsAffected} job{r.parts.jobsAffected === 1 ? '' : 's'} ({fmtPct(r.parts.pctOfVehicles)} of vehicles)
                      {r.parts.currentlyWaiting > 0 ? ` · ${r.parts.currentlyWaiting} currently waiting` : ''}
                    </div>
                    <div className="space-y-0.5">
                      {r.parts.jobs.slice(0, 8).map((j) => (
                        <p key={j.orderId} className="text-xs text-amber-900">
                          <span className="font-mono font-semibold">{j.plate}</span> · {j.services.join(', ')} ·{' '}
                          {fmtDur(j.waitingPartsMs)}{j.visitNumber ? ` · ${j.visitNumber}` : ''}
                        </p>
                      ))}
                      {r.parts.jobs.length > 8 && (
                        <p className="text-[11px] text-amber-700">…and {r.parts.jobs.length - 8} more (see CSV detail)</p>
                      )}
                    </div>
                  </div>
                )}
              </ReportSection>

              {/* ---- Trends (§17) — only when the period is longer than a day ---- */}
              {r.meta.period.days > 1 && (
                <ReportSection title="Trends">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div style={{ breakInside: 'avoid' }}>
                      <p className="text-xs font-semibold text-slate-600 mb-1">Jobs completed per day</p>
                      <MiniBars points={r.trend.map((t) => ({ x: t.date, y: t.jobsCompleted }))} />
                    </div>
                    <div style={{ breakInside: 'avoid' }}>
                      <p className="text-xs font-semibold text-slate-600 mb-1">Avg service time per day ({basisLabel.toLowerCase()})</p>
                      <MiniLine
                        points={r.trend.map((t) => ({ x: t.date, y: basis(t.avgElapsedMs, t.avgTechWorkMs) }))}
                        format={fmtDur}
                      />
                    </div>
                    <div style={{ breakInside: 'avoid' }}>
                      <p className="text-xs font-semibold text-slate-600 mb-1">Arrivals per day</p>
                      <MiniBars points={r.trend.map((t) => ({ x: t.date, y: t.arrivals }))} />
                    </div>
                    <div style={{ breakInside: 'avoid' }}>
                      <p className="text-xs font-semibold text-slate-600 mb-1">Waiting-for-parts delay per day</p>
                      <MiniLine points={r.trend.map((t) => ({ x: t.date, y: t.partsDelayMs }))} format={fmtDur} color="#b45309" />
                    </div>
                  </div>
                </ReportSection>
              )}

              {/* ---- Page 4: Technician Performance (§10/§11) ---- */}
              <ReportSection title="Technician Performance" breakBefore>
                <div className="table-container">
                  <table className="w-full text-sm">
                    <thead className="table-header">
                      <tr><th>Technician</th><th className="text-right">Jobs Assigned</th><th className="text-right">Jobs Completed</th><th className="text-right">Productive Time</th><th className="text-right">Avg Work / Completed</th><th className="text-right">Held / Waiting</th><th className="text-right">Rework</th></tr>
                    </thead>
                    <tbody>
                      {r.technicians.map((t) => (
                        <tr key={t.technicianId} className="table-row">
                          <td>{t.name} <span className="font-mono text-xs text-slate-400">{t.employeeCode}</span></td>
                          <td className="text-right tabular-nums">{t.jobsAssigned}</td>
                          <td className="text-right tabular-nums">{t.jobsCompleted}</td>
                          <td className="text-right tabular-nums font-semibold text-emerald-700">{fmtDur(t.productiveMs)}</td>
                          <td className="text-right tabular-nums">{fmtDur(t.avgWorkPerCompletedMs)}</td>
                          <td className="text-right tabular-nums text-amber-700">{t.heldJobs}</td>
                          <td className="text-right tabular-nums">{t.reworkCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  Productive time is the union of real labour intervals from the segment ledger — overlapping
                  assignments never double-count, and waiting for parts is operational delay, not technician
                  inefficiency. Elapsed Job Time context per job is in the drill-down and CSV.
                </p>
                {/* §11 — drill-down: the jobs behind each row (screen only). */}
                <div className="print:hidden mt-2 space-y-1">
                  {r.technicians.map((t) => (
                    <details key={t.technicianId} className="rounded border border-slate-100">
                      <summary className="cursor-pointer px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                        {t.name} — {t.jobs.length} job{t.jobs.length === 1 ? '' : 's'} in period
                      </summary>
                      <div className="px-3 pb-2 divide-y divide-slate-50">
                        {t.jobs.map((j) => (
                          <div key={j.orderId} className="py-1.5 flex items-center justify-between gap-2 text-xs">
                            <span>
                              <span className="font-mono font-semibold text-slate-800">{j.plate}</span>
                              <span className="text-slate-500 ml-2">{j.services.join(', ')}</span>
                              {j.visitNumber && (
                                <Link href={`/visits/${j.serviceVisitId}`} className="text-blue-700 hover:underline ml-2">{j.visitNumber}</Link>
                              )}
                            </span>
                            <span className="tabular-nums text-slate-600 shrink-0">
                              {fmtDur(j.elapsedMs)} elapsed · {fmtDur(j.techWorkMs)} work
                              {j.waitingPartsMs > 0 ? ` · ${fmtDur(j.waitingPartsMs)} parts` : ''} · {j.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </ReportSection>

              {/* ---- Page 5: Service & Quality (§14/§15/§16) ---- */}
              <ReportSection title="Service Type Performance — Target vs Actual" breakBefore>
                {r.serviceTypes.rows.length === 0 ? (
                  <p className="text-sm text-slate-500">No completed single-service jobs in this period.</p>
                ) : (
                  <div className="table-container">
                    <table className="w-full text-sm">
                      <thead className="table-header">
                        <tr><th>Service</th><th className="text-right">Volume</th><th className="text-right">Target (booked)</th><th className="text-right">Avg Actual ({basisLabel.toLowerCase()})</th><th className="text-right">Variance</th></tr>
                      </thead>
                      <tbody>
                        {r.serviceTypes.rows.map((s) => {
                          const variance = basis(s.varianceElapsedMs, s.varianceTechWorkMs);
                          return (
                            <tr key={s.code} className="table-row">
                              <td>{s.name}</td>
                              <td className="text-right tabular-nums">{s.volume}</td>
                              <td className="text-right tabular-nums">{fmtDur(s.targetMinutes * 60000)}</td>
                              <td className="text-right tabular-nums">{fmtDur(basis(s.avgElapsedMs, s.avgTechWorkMs))}</td>
                              <td className={`text-right tabular-nums font-medium ${variance > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                                {variance > 0 ? '+' : '−'}{fmtDur(Math.abs(variance))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-[11px] text-slate-400 mt-1.5">
                  {r.serviceTypes.note}
                  {r.serviceTypes.multiServiceJobs > 0 ? ` ${r.serviceTypes.multiServiceJobs} multi-service job(s) excluded from this table.` : ''}
                  {' '}Actual uses the selected time basis: {basisLabel.toLowerCase()}.
                </p>
              </ReportSection>

              <ReportSection title="Quality — QC & Rework">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <KpiCard label="Jobs Sent to QC" value={r.quality.jobsSentToQc} />
                  <KpiCard label="First-Time Fix" value={fmtPct(r.quality.firstTimeFixRate)} />
                  <KpiCard label="Reworked Orders" value={r.quality.reworkedOrders} sub={`of ${r.quality.eligibleOrders} orders`} />
                  <KpiCard label="Currently in Rework" value={r.quality.currentlyInRework} />
                </div>
              </ReportSection>

              {/* ---- Attention (§18) — explicit thresholds only ---- */}
              {r.attention.length > 0 && (
                <ReportSection title="Items Requiring Attention">
                  <div className="space-y-1.5">
                    {r.attention.map((a, i) => (
                      <div key={i} className="rounded-lg border border-red-200 bg-red-50/50 px-3 py-2" style={{ breakInside: 'avoid' }}>
                        <p className="text-sm font-medium text-red-900">{a.label}</p>
                        <p className="text-xs text-red-800">{a.detail}</p>
                        <p className="text-[10px] text-red-600">Threshold: {a.threshold}</p>
                      </div>
                    ))}
                  </div>
                </ReportSection>
              )}

              {/* ---- Metric definitions (§26) — quiet appendix ---- */}
              <ReportSection title="Metric Definitions">
                <div className="text-[11px] text-slate-500 space-y-1 leading-relaxed">
                  <p><b>Vehicles Serviced</b> — distinct visits among jobs started in the period; several jobs on one vehicle count once.</p>
                  <p><b>Elapsed Service Time</b> — wall-clock duration between service start and completion, including measured operational holds.</p>
                  <p><b>Technician Work Time</b> — union of active technician labour intervals from the segment ledger, excluding recorded holds; one person can never exceed the clock.</p>
                  <p><b>Waiting for Parts / Customer</b> — measured pause-ledger intervals while a job sits in that state.</p>
                  <p><b>Rework Rate</b> — orders requiring rework ÷ orders in the period.</p>
                  <p><b>Average Queue Wait</b> — average time from ticket generation to service call, from queue status history.</p>
                  <p><b>Target (booked)</b> — the booked service duration from the service catalogue.</p>
                </div>
              </ReportSection>

              {/* ---- Print footer (§23) ---- */}
              <div className="hidden print:block text-[10px] text-slate-500 border-t border-slate-300 pt-2 mt-4">
                Generated {new Date(r.meta.generatedAt).toLocaleString()}
                {r.meta.generatedBy ? ` by ${r.meta.generatedBy}` : ''} · Internal Management Use
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- Other reports (screen only) ---- */}
      <section className="print:hidden mt-8">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">More reports</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Link href="/reports/technician-kpi" className="card p-4 hover:border-blue-300 hover:shadow-sm transition-all">
            <h3 className="text-sm font-semibold text-slate-900">Technician KPI</h3>
            <p className="text-xs text-slate-500 mt-1">Benchmarked job ratings against time standards.</p>
          </Link>
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
