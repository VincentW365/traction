'use client';

import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../hooks/use-auth';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import { ExportMenu } from '../../../../components/ui/export-menu';
import type { ExportDocument } from '../../../../lib/export';
import { KPI_PACKAGE_LABEL, VEHICLE_CLASS_LABEL } from '../../../../components/kpi-strip';

/**
 * CR-2026-090 — jobs more than one technician worked on.
 *
 * Job time is wall-clock and there is one of it. Labour time is per person, and a
 * shared job carries more labour than it lasted: two technicians working one hour
 * side by side is one hour of job time and two hours of labour. Every number on this
 * page belongs to one of those two families and is labelled as such, because the
 * classic wrong answer is to read a labour total as a duration.
 *
 * No per-technician rating appears here and none may be added. The data cannot split
 * a job's elapsed time between the people who worked it — no formula turns "two
 * people were on this" into "Marcus did 62% of it" — so what is reported instead is
 * measured: who was on the job, how long each was working, and how much of that was
 * side by side.
 */

const ALLOWED_ROLES = ['ADMIN'];

/**
 * Must read exactly as the API's row-level note. The API repeats it on every row so
 * the caveat leaves the screen with the data; a caveat that only lives in a heading
 * is the one that gets lost the moment someone downloads the CSV and mails it round.
 */
const INFORMATIONAL_NOTE =
  'Informational only — not included in individual KPI comparison.';

const ROLE_LABEL: Record<string, string> = {
  PRIMARY: 'Primary',
  ASSISTING: 'Assisting',
  REPLACEMENT: 'Replacement',
};

const ROLE_BADGE: Record<string, string> = {
  PRIMARY: 'bg-blue-50 text-blue-700',
  ASSISTING: 'bg-emerald-50 text-emerald-700',
  REPLACEMENT: 'bg-violet-50 text-violet-700',
};

interface SharedJobTechnician {
  technicianId: string;
  technicianCode: string | null;
  technicianName: string | null;
  role: string | null;
  activeMinutes: number;
  segmentCount: number;
}

interface SharedJobRow {
  serviceOrderId: string;
  ticketNumber: string | null;
  plate: string | null;
  vehicleClass: string | null;
  packageType: string;
  standardMinutes: number | null;
  kpiCompletionMinutes: number | null;
  policyVersion: number;
  firstWorkStartedAt: string | null;
  firstSubmittedToQcAt: string | null;
  hadRework: boolean;
  technicianCount: number;
  teamLabourMinutes: number;
  activeCoverageMinutes: number;
  concurrentAssistMinutes: number;
  excludedCoverageMinutes: number;
  wasReassigned: boolean;
  technicians: SharedJobTechnician[];
  individualRating: null;
  note: string;
}

interface SharedJobsReport {
  rows: SharedJobRow[];
  note: string;
  totals: {
    jobs: number;
    teamLabourMinutes: number;
    concurrentAssistMinutes: number;
  };
}

interface TechnicianBasic {
  id: string;
  employeeCode: string;
  userAccount: { fullName: string };
}

function localISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISO(d);
}

function mins(n: number | null | undefined) {
  return n == null ? '--' : `${n} min`;
}
function hours(n: number) {
  return `${(n / 60).toFixed(1)} h`;
}
function shortDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString() : '';
}
function dateTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '';
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="input-label">{label}</div>
      <div className="text-2xl font-bold text-slate-900 tabular-nums mt-0.5">{value}</div>
      {hint && <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>}
    </div>
  );
}

/** One measure with its definition attached, so it is never read as a plain duration. */
function Measure({ label, value, meaning }: { label: string; value: string; meaning: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-bold text-slate-900 tabular-nums mt-0.5">{value}</div>
      <div className="text-[11px] text-slate-500 mt-1 leading-snug">{meaning}</div>
    </div>
  );
}

export default function SharedJobsPage() {
  const { user } = useAuth();
  const siteId = useSiteId();
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(localISO(new Date()));
  const [technicianId, setTechnicianId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const allowed = ALLOWED_ROLES.includes(user?.roleCode ?? '');

  const qs = new URLSearchParams({
    from,
    to,
    ...(technicianId && { technicianId }),
  }).toString();

  const report = useQuery<SharedJobsReport>({
    queryKey: ['kpi-shared-jobs', qs],
    queryFn: () => api.get(`/kpi/reports/shared-jobs?${qs}`),
    enabled: allowed,
  });

  // The filter matches any technician who worked the job, not just the primary, so
  // the list has to cover every technician on site rather than the assigned ones.
  const techs = useQuery<TechnicianBasic[]>({
    queryKey: ['technicians', siteId],
    queryFn: () => api.get(`/technicians?siteId=${siteId}`),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <div className="page-container">
        <PageHeader title="Shared and Reassigned Jobs" subtitle="Manager report" />
        <div className="card p-6 text-sm text-slate-600">
          You do not have permission to view this report.
        </div>
      </div>
    );
  }

  const data = report.data;
  const rows = data?.rows ?? [];
  const note = data?.note ?? INFORMATIONAL_NOTE;

  const totalCoverage = rows.reduce((a, r) => a + r.activeCoverageMinutes, 0);
  const totalExcluded = rows.reduce((a, r) => a + r.excludedCoverageMinutes, 0);
  const reassignedJobs = rows.filter((r) => r.wasReassigned).length;

  const selectedTech = techs.data?.find((t) => t.id === technicianId);
  const technicianLabel = selectedTech
    ? `${selectedTech.userAccount.fullName} (${selectedTech.employeeCode})`
    : 'All technicians';

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const buildExport = (): ExportDocument | null => {
    if (!data) return null;
    return {
      filename: 'shared-reassigned-jobs',
      title: 'Shared and Reassigned Jobs',
      subtitle: `${from} to ${to}`,
      meta: [
        ['Note', note],
        ['Basis', 'Job time is wall-clock. Labour time is per person and can exceed it.'],
        ['Technician', technicianLabel],
      ],
      sections: [
        {
          heading: 'Totals',
          columns: ['Measure', 'Value'],
          rows: [
            ['Shared or reassigned jobs', data.totals.jobs],
            ['Of which reassigned', reassignedJobs],
            ['Team labour minutes (sum of every technician)', data.totals.teamLabourMinutes],
            ['Active coverage minutes (anyone working)', totalCoverage],
            ['Concurrent assistance minutes (two or more at once)', data.totals.concurrentAssistMinutes],
            ['Excluded coverage minutes (approved job-wide delay)', totalExcluded],
          ],
          note,
        },
        {
          // Every row carries the note as its own column, and the policy version so
          // the export can be reconciled after the standards change.
          heading: 'Jobs',
          columns: [
            'Ticket', 'Plate', 'Class', 'Package', 'Standard min', 'Job time min',
            'Technicians', 'Reassigned', 'Rework', 'Team labour min', 'Active coverage min',
            'Concurrent assist min', 'Excluded coverage min', 'Individual rating',
            'Policy v', 'First started', 'Submitted to QC', 'Note',
          ],
          rows: rows.map((r) => [
            r.ticketNumber ?? '', r.plate ?? '',
            r.vehicleClass ? VEHICLE_CLASS_LABEL[r.vehicleClass] ?? r.vehicleClass : '',
            KPI_PACKAGE_LABEL[r.packageType] ?? r.packageType,
            r.standardMinutes ?? '', r.kpiCompletionMinutes ?? '',
            r.technicianCount, r.wasReassigned ? 'Yes' : 'No', r.hadRework ? 'Yes' : 'No',
            r.teamLabourMinutes, r.activeCoverageMinutes, r.concurrentAssistMinutes,
            r.excludedCoverageMinutes, 'Not rated',
            r.policyVersion, dateTime(r.firstWorkStartedAt), dateTime(r.firstSubmittedToQcAt),
            r.note,
          ]),
          note,
        },
        {
          heading: 'Technician breakdown',
          columns: ['Ticket', 'Technician', 'Code', 'Role', 'Active minutes', 'Segments', 'Note'],
          rows: rows.flatMap((r) =>
            r.technicians.map((t) => [
              r.ticketNumber ?? '',
              t.technicianName ?? '',
              t.technicianCode ?? '',
              t.role ? ROLE_LABEL[t.role] ?? t.role : '',
              t.activeMinutes,
              t.segmentCount,
              r.note,
            ]),
          ),
          note,
        },
      ],
    };
  };

  return (
    <div className="page-container">
      <PageHeader
        title="Shared and Reassigned Jobs"
        subtitle="Jobs worked by more than one technician, measured in labour rather than rated"
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Shared Jobs' }]}
        actions={<ExportMenu build={buildExport} disabled={!data} />}
      />

      {/* The exclusion is the reason the report exists, so it leads the page. */}
      <div className="card border-amber-200 bg-amber-50 p-4 mb-4">
        <p className="text-sm font-semibold text-amber-900">{note}</p>
        <p className="text-xs text-amber-800 mt-1.5 leading-relaxed">
          Job time is wall-clock and there is one of it. Labour time is per person, and a
          shared job carries more labour than it lasted — two technicians working one hour
          side by side is one hour of job time and two hours of labour. No per-technician
          rating is shown, because a job&apos;s elapsed time cannot be split between the
          people who worked it. What follows is measured: who was on the job, how long each
          was working, and how much of that was side by side.
        </p>
      </div>

      {/* Filters */}
      <div className="card p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="input-label">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="input-label">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="input-label">Technician</label>
          <select
            value={technicianId}
            onChange={(e) => setTechnicianId(e.target.value)}
            className="input-field"
          >
            <option value="">All technicians</option>
            {(techs.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.userAccount.fullName} ({t.employeeCode})
              </option>
            ))}
          </select>
          <p className="text-[11px] text-slate-400 mt-1">Any job they worked, not only the ones they led.</p>
        </div>
      </div>

      {report.isLoading ? (
        <LoadingState message="Loading shared jobs..." />
      ) : report.isError ? (
        <div className="card p-6 text-center border-red-200 bg-red-50">
          <p className="text-sm text-red-700">Failed to load this report.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-6 text-sm text-slate-600">
          No shared or reassigned jobs in this range. A job appears here once a second
          technician records work against it, or the job is handed to a replacement.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat
              label="Shared / reassigned jobs"
              value={String(data?.totals.jobs ?? rows.length)}
              hint={`${reassignedJobs} reassigned`}
            />
            <Stat
              label="Team labour"
              value={mins(data?.totals.teamLabourMinutes ?? 0)}
              hint={hours(data?.totals.teamLabourMinutes ?? 0)}
            />
            <Stat
              label="Active coverage"
              value={mins(totalCoverage)}
              hint="wall-clock, counted once"
            />
            <Stat
              label="Concurrent assistance"
              value={mins(data?.totals.concurrentAssistMinutes ?? 0)}
              hint="two or more at once"
            />
          </div>

          {/* The four measures answer four different manager questions and are easy to
              confuse, so each carries its definition wherever it is totalled. */}
          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">The four labour measures</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Measure
                label="Team labour"
                value={mins(data?.totals.teamLabourMinutes ?? 0)}
                meaning="What the work cost in labour. Every technician's active minutes added together, so it can exceed the time the job took."
              />
              <Measure
                label="Active coverage"
                value={mins(totalCoverage)}
                meaning="How long anyone was working on it. Wall-clock, counted once however many people were on it."
              />
              <Measure
                label="Concurrent assistance"
                value={mins(data?.totals.concurrentAssistMinutes ?? 0)}
                meaning="How long two or more technicians were on it at the same time. Zero on a job that was handed over rather than shared."
              />
              <Measure
                label="Excluded coverage"
                value={mins(totalExcluded)}
                meaning="Approved job-wide delay, such as a parts wait. Deducted from coverage once — never from each technician, which would erase labour the delay cannot justify."
              />
            </div>
          </div>

          <div className="table-container">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-900">Jobs</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Standard and job time are wall-clock; team labour is per person. Open a row
                for who worked it and for how long. {note}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1050px]">
                <thead>
                  <tr className="table-header">
                    <th>Ticket</th>
                    <th>Class / package</th>
                    <th className="text-center">Standard</th>
                    <th className="text-center">Job time</th>
                    <th className="text-center">Techs</th>
                    <th className="text-center">Team labour</th>
                    <th className="text-center">Coverage</th>
                    <th className="text-center">Concurrent</th>
                    <th className="text-center">Individual rating</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const open = expanded.has(r.serviceOrderId);
                    return (
                      <Fragment key={r.serviceOrderId}>
                        <tr className="border-b border-slate-50">
                          <td className="px-5 py-3">
                            <button
                              type="button"
                              onClick={() => toggle(r.serviceOrderId)}
                              className="flex items-start gap-2 text-left"
                              aria-expanded={open}
                            >
                              <svg
                                className={`w-3.5 h-3.5 mt-1 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                              </svg>
                              <span>
                                <span className="text-sm font-mono text-slate-800">{r.ticketNumber ?? '--'}</span>
                                <span className="block text-[11px] text-slate-400">
                                  {r.plate ?? ''}
                                  {r.plate && r.firstSubmittedToQcAt ? ' · ' : ''}
                                  {shortDate(r.firstSubmittedToQcAt)}
                                </span>
                              </span>
                            </button>
                          </td>
                          <td className="text-xs text-slate-600">
                            {r.vehicleClass ? VEHICLE_CLASS_LABEL[r.vehicleClass] ?? r.vehicleClass : '--'}
                            <span className="block text-[11px] text-slate-400">
                              {KPI_PACKAGE_LABEL[r.packageType] ?? r.packageType}
                            </span>
                          </td>
                          <td className="text-center text-sm tabular-nums">{r.standardMinutes ?? '--'}</td>
                          <td className="text-center text-sm tabular-nums">
                            {r.kpiCompletionMinutes ?? '--'}
                            {r.excludedCoverageMinutes > 0 && (
                              <span className="block text-[10px] text-slate-400">
                                −{r.excludedCoverageMinutes} excluded
                              </span>
                            )}
                          </td>
                          <td className="text-center text-sm tabular-nums">
                            {r.technicianCount}
                            {r.wasReassigned && (
                              <span className="block text-[10px] text-violet-600">reassigned</span>
                            )}
                          </td>
                          <td className="text-center text-sm tabular-nums font-semibold text-slate-900">
                            {r.teamLabourMinutes}
                            <span className="block text-[10px] text-slate-400">per person, summed</span>
                          </td>
                          <td className="text-center text-sm tabular-nums">{r.activeCoverageMinutes}</td>
                          <td className="text-center text-sm tabular-nums">
                            {r.concurrentAssistMinutes}
                            {r.concurrentAssistMinutes === 0 && (
                              <span className="block text-[10px] text-slate-400">handover, not shared</span>
                            )}
                          </td>
                          <td className="text-center">
                            {/* individualRating is null by design; the badge says so on the
                                row rather than leaving an empty cell to be filled in later. */}
                            <span className="badge bg-slate-100 text-slate-500 text-[10px]" title={r.note}>
                              not rated
                            </span>
                            {r.hadRework && (
                              <span className="block text-[10px] text-red-600 mt-0.5">came back from QC</span>
                            )}
                          </td>
                        </tr>

                        {open && (
                          <tr className="border-b border-slate-100 bg-slate-50">
                            <td colSpan={9} className="px-5 py-4">
                              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3">
                                <span className="text-xs font-semibold text-slate-700">
                                  Who worked this job
                                </span>
                                <span className="text-xs text-slate-500">
                                  Standard {mins(r.standardMinutes)} · job time {mins(r.kpiCompletionMinutes)}
                                </span>
                                <span className="text-[11px] text-slate-400">policy v{r.policyVersion}</span>
                              </div>
                              {/* Role is snapshotted per segment and the API reports the
                                  first one, so a technician promoted mid-job still reads
                                  as what they started as. */}
                              <p className="text-[11px] text-slate-400 mb-2">
                                Role is as at the technician&apos;s first spell on this job.
                              </p>

                              <table className="w-full mb-3">
                                <thead>
                                  <tr className="border-b border-slate-200">
                                    <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 pb-1">Technician</th>
                                    <th className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 pb-1">Role</th>
                                    <th className="text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500 pb-1">Active minutes</th>
                                    <th className="text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500 pb-1">Segments</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.technicians.map((t) => (
                                    <tr key={t.technicianId} className="border-b border-slate-100 last:border-0">
                                      <td className="py-1.5">
                                        <span className="text-sm text-slate-800">{t.technicianName ?? '--'}</span>
                                        <span className="block text-[11px] text-slate-400 font-mono">{t.technicianCode ?? ''}</span>
                                      </td>
                                      <td className="py-1.5">
                                        {t.role ? (
                                          <span className={`badge text-[10px] ${ROLE_BADGE[t.role] ?? 'bg-slate-100 text-slate-600'}`}>
                                            {ROLE_LABEL[t.role] ?? t.role}
                                          </span>
                                        ) : (
                                          <span className="text-xs text-slate-400">--</span>
                                        )}
                                      </td>
                                      <td className="text-center text-sm tabular-nums py-1.5">{t.activeMinutes}</td>
                                      <td className="text-center text-sm tabular-nums py-1.5">
                                        {t.segmentCount}
                                        {t.segmentCount > 1 && (
                                          <span className="block text-[10px] text-slate-400">worked in spells</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>

                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                                <Measure
                                  label="Team labour"
                                  value={mins(r.teamLabourMinutes)}
                                  meaning="Every technician's active minutes added together."
                                />
                                <Measure
                                  label="Active coverage"
                                  value={mins(r.activeCoverageMinutes)}
                                  meaning="Wall-clock during which at least one of them was working."
                                />
                                <Measure
                                  label="Concurrent assistance"
                                  value={mins(r.concurrentAssistMinutes)}
                                  meaning="Wall-clock during which two or more were working at once."
                                />
                                <Measure
                                  label="Excluded coverage"
                                  value={mins(r.excludedCoverageMinutes)}
                                  meaning="Approved job-wide delay, deducted from coverage once."
                                />
                              </div>

                              <p className="text-[11px] text-slate-500 mt-3">{r.note}</p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t border-slate-100 text-[11px] text-slate-500">
              {note}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
