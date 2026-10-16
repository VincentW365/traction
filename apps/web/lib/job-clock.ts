/**
 * CR-2026-125 — the one piece of arithmetic behind a technician's job clock.
 *
 * Both technician screens (My Jobs and the job workspace) used to compute
 * "Elapsed" and "Working" inline as `now − startedAt`, which is right while the
 * job is live and wrong the moment it is not: a job sent to Quality Check kept
 * counting on the screen for as long as it stayed open, although the API had
 * already stamped `completedAt` and closed every labour segment. The clock
 * stops at `completedAt`; "now" is only the end bound while there is no end.
 *
 * Pure, so the stop is testable without a browser.
 */

export interface JobClockInput {
  startedAt: string | null;
  /** Stamped on entry to Quality Check; null while the job is live. */
  completedAt?: string | null;
  /** Closed pauses, already summed by the API. */
  pausedMs: number;
  /** The pause currently open, if any. */
  openPauseStartedAt: string | null;
}

export interface JobClock {
  /** The job has a start; the clocks have something to show. */
  started: boolean;
  /** The job has been handed to Quality Check; both figures are final. */
  finished: boolean;
  /** Wall time from start to the end bound (completion, or now). Never negative. */
  elapsedMs: number;
  /** Elapsed less every pause, closed or open. Never negative. */
  workingMs: number;
  /** The end bound used, as epoch ms; null until started. */
  endMs: number | null;
}

const ZERO: JobClock = { started: false, finished: false, elapsedMs: 0, workingMs: 0, endMs: null };

export function jobClock(t: JobClockInput | null | undefined, now: number): JobClock {
  if (!t?.startedAt) return ZERO;
  const startedMs = new Date(t.startedAt).getTime();
  if (Number.isNaN(startedMs)) return ZERO;

  const completedMs = t.completedAt ? new Date(t.completedAt).getTime() : NaN;
  const finished = !Number.isNaN(completedMs);
  // A finished job's end is its completion, full stop — not whatever time it is
  // on the screen that happens to be showing it.
  const endMs = finished ? completedMs : now;

  const elapsedMs = Math.max(0, endMs - startedMs);
  const openPauseMs = t.openPauseStartedAt
    ? Math.max(0, endMs - new Date(t.openPauseStartedAt).getTime())
    : 0;
  const workingMs = Math.max(0, elapsedMs - (t.pausedMs || 0) - openPauseMs);

  return { started: true, finished, elapsedMs, workingMs, endMs };
}
