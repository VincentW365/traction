/**
 * Jobs → ServiceVisit/ServiceOrder import mapper (CR-2026-005) — PURE, no I/O.
 *
 * Maps SharePoint "Service Center: Job Sheet" rows to historical, TERMINAL visit/order
 * shapes. No Prisma/fs/network. `notes` carries raw free-text (authed-only) and must
 * NEVER appear in logs or dry-run reports — the report builder takes counts only.
 *
 * Source columns: Id (job id), CustomerNo.Id (link → Vehicle ref), field_3 (Oil Type),
 * field_6 (Assigned To, "; "-joined), field_13 (Comment), CurrentMileage,
 * ServiceDetail(s), JobStart, JobPause, JobResume, RectifyStartTime, RectifyEndTime,
 * EndTime2, Status, Created.
 */

export type TerminalVisitStatus = 'CLOSED' | 'CANCELLED';
export type ResolutionKind = 'RESOLVED' | 'UNRESOLVED_LINKED' | 'UNLINKED';

export interface RawJobRow {
  jobId: string;
  customerNoId: string;
  status: string;
  oil: string;
  techs: string;
  comment: string;
  mileage: string;
  serviceDetail: string;
  created: string;
  jobStart: string;
  jobPause: string;
  jobResume: string;
  rectifyStart: string;
  rectifyEnd: string;
  endTime2: string;
}

export interface PlannedJob {
  jobId: string;
  customerNoId: string | null;
  visitStatus: TerminalVisitStatus;
  orderStatus: TerminalVisitStatus;
  sourceStatus: string; // original SharePoint status, preserved for honesty
  visitDate: Date | null;
  mileageIn: number | null;
  mileageSuspect: boolean;
  oil: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  notes: string; // RAW free text — authed-only, never logged or in reports
  techNames: string[];
  pause: { startedAt: Date; endedAt: Date | null } | null;
  rework: { openedAt: Date; closedAt: Date | null } | null;
}

const MILEAGE_SUSPECT_OVER = 400000;

export function rawJobFromCsv(r: Record<string, string>): RawJobRow {
  const g = (k: string) => (r[k] ?? '').trim();
  return {
    jobId: g('Id'),
    customerNoId: g('CustomerNo.Id'),
    status: g('Status'),
    oil: g('field_3'),
    techs: g('field_6'),
    comment: g('field_13'),
    mileage: g('CurrentMileage'),
    serviceDetail: g('ServiceDetail(s)'),
    created: g('Created'),
    jobStart: g('JobStart'),
    jobPause: g('JobPause'),
    jobResume: g('JobResume'),
    rectifyStart: g('RectifyStartTime'),
    rectifyEnd: g('RectifyEndTime'),
    endTime2: g('EndTime2'),
  };
}

export function parseDateTime(s: string): Date | null {
  const v = (s || '').trim();
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function parseMileage(s: string): number | null {
  const v = (s || '').replace(/[, ]/g, '').trim();
  if (!v || !/^\d+$/.test(v)) return null;
  return Number(v);
}

/** Completed→CLOSED, Cancelled→CANCELLED, everything else→CLOSED (terminal historical). */
export function mapStatus(source: string): { visitStatus: TerminalVisitStatus; orderStatus: TerminalVisitStatus } {
  const s = (source || '').trim().toLowerCase();
  if (s === 'cancelled') return { visitStatus: 'CANCELLED', orderStatus: 'CANCELLED' };
  return { visitStatus: 'CLOSED', orderStatus: 'CLOSED' };
}

/** Split the "; "-joined assigned-to field; drop blanks and the T.B.A placeholder. */
export function parseTechNames(s: string): string[] {
  return (s || '')
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter((t) => t && t.toUpperCase().replace(/[^A-Z]/g, '') !== 'TBA');
}

/** Normalized key for matching a tech name to the seeded roster (e.g. "O.Josephs" / "O. Josephs"). */
export function normalizeTechName(s: string): string {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function resolutionKind(customerNoId: string | null, resolvable: boolean): ResolutionKind {
  if (!customerNoId) return 'UNLINKED';
  return resolvable ? 'RESOLVED' : 'UNRESOLVED_LINKED';
}

export function mapJob(r: RawJobRow): PlannedJob {
  const { visitStatus, orderStatus } = mapStatus(r.status);
  const mileageIn = parseMileage(r.mileage);
  const oil = r.oil && r.oil.trim() && r.oil.trim().toLowerCase() !== 'not servicing' ? r.oil.trim() : null;
  const notes = [r.serviceDetail, r.comment].map((x) => (x || '').trim()).filter(Boolean).join(' | ');

  const pStart = parseDateTime(r.jobPause);
  const pause = pStart ? { startedAt: pStart, endedAt: parseDateTime(r.jobResume) } : null;
  const rStart = parseDateTime(r.rectifyStart);
  const rework = rStart ? { openedAt: rStart, closedAt: parseDateTime(r.rectifyEnd) } : null;

  return {
    jobId: r.jobId,
    customerNoId: r.customerNoId || null,
    visitStatus,
    orderStatus,
    sourceStatus: r.status || '(blank)',
    visitDate: parseDateTime(r.created),
    mileageIn,
    mileageSuspect: mileageIn != null && mileageIn > MILEAGE_SUSPECT_OVER,
    oil,
    startedAt: parseDateTime(r.jobStart),
    completedAt: parseDateTime(r.endTime2),
    notes,
    techNames: parseTechNames(r.techs),
    pause,
    rework,
  };
}

// ---------------------------------------------------------------------------
// Dry-run report — COUNTS ONLY. Never receives or emits raw notes/comments.
// ---------------------------------------------------------------------------
export interface JobImportStats {
  sourceFile: string;
  rows: number;
  resolved: number;
  unresolvedLinked: number;
  unlinked: number;
  placeholdersNeeded: number;
  statusCompleted: number;
  statusCancelled: number;
  staleImportedAsTerminal: number;
  visitClosed: number;
  visitCancelled: number;
  techAssignments: number;
  techResolved: number;
  techUnresolved: number;
  pauses: number;
  rework: number;
  mileageSuspect: number;
}

export function buildJobDryRunReport(s: JobImportStats): string {
  return [
    `# Jobs / Visits Historical Import — DRY RUN`,
    ``,
    `> No database writes. Source: \`${s.sourceFile}\`. Counts only — no raw comments/details (CR-2026-005).`,
    ``,
    `## Resolution`,
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Jobs read | ${s.rows} |`,
    `| Resolved to real customer/vehicle | ${s.resolved} |`,
    `| Linked but unresolved (placeholder) | ${s.unresolvedLinked} |`,
    `| Unlinked, no CustomerNo (placeholder) | ${s.unlinked} |`,
    `| **Placeholder visits needed** | ${s.placeholdersNeeded} |`,
    ``,
    `## Status mapping (all imported as TERMINAL historical)`,
    `| Source | → | Count |`,
    `| --- | --- | ---: |`,
    `| Completed → CLOSED | | ${s.statusCompleted} |`,
    `| Cancelled → CANCELLED | | ${s.statusCancelled} |`,
    `| Stale (In-Progress/Not Started/Pause) → CLOSED (terminal) | | ${s.staleImportedAsTerminal} |`,
    `| Resulting visit CLOSED / CANCELLED | | ${s.visitClosed} / ${s.visitCancelled} |`,
    ``,
    `## Technicians / ledgers / data quality`,
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Technician assignments (resolved / unresolved) | ${s.techResolved} / ${s.techUnresolved} of ${s.techAssignments} |`,
    `| Pause ledger rows | ${s.pauses} |`,
    `| Rework ledger rows | ${s.rework} |`,
    `| Mileage suspect (> ${MILEAGE_SUSPECT_OVER.toLocaleString()}) | ${s.mileageSuspect} |`,
    ``,
  ].join('\n');
}
