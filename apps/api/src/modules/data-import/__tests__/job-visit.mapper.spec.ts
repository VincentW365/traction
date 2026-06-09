import { describe, it, expect } from 'vitest';
import {
  mapJob, mapStatus, parseTechNames, normalizeTechName, parseMileage, parseDateTime,
  resolutionKind, buildJobDryRunReport,
  type RawJobRow, type JobImportStats,
} from '../job-visit.mapper';

// Synthetic only — no real PII.
function jrow(p: Partial<RawJobRow> = {}): RawJobRow {
  return {
    jobId: '1', customerNoId: '', status: 'Completed', oil: 'Regular Oil', techs: 'O.Josephs',
    comment: '', mileage: '50000', serviceDetail: 'Brake job', created: '2024-01-15T10:00:00Z',
    jobStart: '2024-01-15T10:05:00Z', jobPause: '', jobResume: '', rectifyStart: '', rectifyEnd: '',
    endTime2: '2024-01-15T11:00:00Z', ...p,
  };
}

describe('job mapper helpers', () => {
  it('status maps to terminal (Completed→CLOSED, Cancelled→CANCELLED, stale→CLOSED)', () => {
    expect(mapStatus('Completed')).toEqual({ visitStatus: 'CLOSED', orderStatus: 'CLOSED' });
    expect(mapStatus('Cancelled')).toEqual({ visitStatus: 'CANCELLED', orderStatus: 'CANCELLED' });
    expect(mapStatus('In-Progress')).toEqual({ visitStatus: 'CLOSED', orderStatus: 'CLOSED' });
    expect(mapStatus('Not Started')).toEqual({ visitStatus: 'CLOSED', orderStatus: 'CLOSED' });
  });
  it('parses tech names, drops T.B.A', () => {
    expect(parseTechNames('D.Hibbert; O.Josephs')).toEqual(['D.Hibbert', 'O.Josephs']);
    expect(parseTechNames('T.B.A')).toEqual([]);
  });
  it('normalizes tech name for roster matching', () => {
    expect(normalizeTechName('O.Josephs')).toBe(normalizeTechName('O. Josephs'));
  });
  it('parses mileage (commas) and datetimes', () => {
    expect(parseMileage('47,245')).toBe(47245);
    expect(parseMileage('n/a')).toBeNull();
    expect(parseDateTime('')).toBeNull();
    expect(parseDateTime('2024-01-15T10:00:00Z')?.getUTCFullYear()).toBe(2024);
  });
  it('resolutionKind classifies linked/unlinked', () => {
    expect(resolutionKind('286', true)).toBe('RESOLVED');
    expect(resolutionKind('286', false)).toBe('UNRESOLVED_LINKED');
    expect(resolutionKind(null, false)).toBe('UNLINKED');
  });
});

describe('mapJob', () => {
  it('maps a completed job to a terminal historical plan, preserving source status', () => {
    const j = mapJob(jrow({ status: 'In-Progress', customerNoId: '286' }));
    expect(j.visitStatus).toBe('CLOSED');
    expect(j.sourceStatus).toBe('In-Progress'); // preserved for honesty
    expect(j.customerNoId).toBe('286');
    expect(j.startedAt?.getUTCHours()).toBe(10);
    expect(j.completedAt?.getUTCHours()).toBe(11);
  });
  it('"Not Servicing" oil → null; suspect mileage flagged', () => {
    expect(mapJob(jrow({ oil: 'Not Servicing' })).oil).toBeNull();
    expect(mapJob(jrow({ mileage: '500000' })).mileageSuspect).toBe(true);
    expect(mapJob(jrow({ mileage: '50000' })).mileageSuspect).toBe(false);
  });
  it('builds pause ledger from JobPause/Resume and rework from Rectify', () => {
    const j = mapJob(jrow({ jobPause: '2024-01-15T10:20:00Z', jobResume: '2024-01-15T10:40:00Z', rectifyStart: '2024-01-16T09:00:00Z', rectifyEnd: '2024-01-16T09:30:00Z' }));
    expect(j.pause?.startedAt?.getUTCMinutes()).toBe(20);
    expect(j.pause?.endedAt?.getUTCMinutes()).toBe(40);
    expect(j.rework?.openedAt?.getUTCDate()).toBe(16);
    expect(mapJob(jrow()).pause).toBeNull();
    expect(mapJob(jrow()).rework).toBeNull();
  });
});

describe('dry-run PII safety', () => {
  it('raw comment goes to notes (authed) but NEVER into the dry-run report (counts only)', () => {
    const SECRET = 'CUSTOMER-NOTE-SECRET-123';
    const j = mapJob(jrow({ comment: SECRET, serviceDetail: 'oil change' }));
    expect(j.notes).toContain(SECRET); // stored on the record (authed)

    const stats: JobImportStats = {
      sourceFile: 'jobs.csv', rows: 1, resolved: 1, unresolvedLinked: 0, unlinked: 0, placeholdersNeeded: 0,
      statusCompleted: 1, statusCancelled: 0, staleImportedAsTerminal: 0, visitClosed: 1, visitCancelled: 0,
      techAssignments: 1, techResolved: 1, techUnresolved: 0, pauses: 0, rework: 0, mileageSuspect: 0,
    };
    const report = buildJobDryRunReport(stats);
    expect(report).not.toContain(SECRET); // counts-only — no raw notes can leak
    expect(report).toContain('Jobs read');
  });
});
