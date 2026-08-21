/**
 * CR-2026-090 — labour measures derived from technician work segments.
 *
 * The distinction this file exists to make:
 *
 *   JOB time     wall-clock from first Start Work to first Submit to QC. One number
 *                per job. This is what `calculateKpi` produces and what the manager's
 *                benchmark table rates. Unchanged by this file.
 *
 *   LABOUR time  how long people actually spent. On a solo job it looks the same as
 *                job time; on a shared job it does not, and the difference is the
 *                whole point. Two technicians working one hour side by side is one
 *                hour of job time and two hours of labour.
 *
 * Conflating them produces the two classic wrong answers: rating a technician on a
 * clock that was running while they were on another job, and reporting that a job
 * "took two hours" when two people spent an hour each.
 *
 * Four measures, because managers ask four different questions:
 *
 *   technicianActiveMinutes    "how long did Marcus spend on this?"     per technician
 *   teamLabourMinutes          "what did this job cost in labour?"      sum
 *   activeCoverageMinutes      "how long was anyone working on it?"     union
 *   concurrentAssistMinutes    "how long were two people on it at once?" overlap
 *
 * On a solo job with no pauses: active = team = coverage, and concurrent = 0.
 *
 * Pure functions — no database, no clock. `now` is always passed in.
 */

const MS_PER_MINUTE = 60_000;

export interface Segment {
  technicianId: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface ExclusionSpan {
  startedAt: Date;
  endedAt: Date | null;
}

interface Interval {
  start: number;
  end: number;
}

/**
 * Resolve spans to closed numeric intervals, dropping anything unusable.
 *
 * An open segment is measured to `now`. A zero-length or reversed interval is
 * dropped rather than clamped: it means the data is wrong, and a silently clamped
 * zero reads as a real measurement of nothing.
 */
function toIntervals(
  spans: readonly { startedAt: Date; endedAt: Date | null }[],
  now: Date,
): Interval[] {
  return spans
    .map((s) => ({
      start: s.startedAt.getTime(),
      end: (s.endedAt ?? now).getTime(),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
}

/** Merge overlapping intervals into a disjoint, sorted set. */
function merge(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const out: Interval[] = [{ ...intervals[0] }];
  for (let i = 1; i < intervals.length; i++) {
    const cur = intervals[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

function totalMs(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
}

/** Everything in `base` that is not covered by `cut`. */
function subtract(base: Interval[], cut: Interval[]): Interval[] {
  if (cut.length === 0) return base;
  const out: Interval[] = [];
  for (const b of base) {
    let cursor = b.start;
    for (const c of cut) {
      if (c.end <= cursor) continue;
      if (c.start >= b.end) break;
      if (c.start > cursor) out.push({ start: cursor, end: Math.min(c.start, b.end) });
      cursor = Math.max(cursor, c.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out.filter((i) => i.end > i.start);
}

/**
 * Total wall-clock covered by at least `minDepth` simultaneous intervals.
 *
 * A sweep over interval endpoints. `minDepth: 1` is the union (how long anyone was
 * working); `minDepth: 2` is the overlap (how long two or more were).
 */
function minutesAtDepth(intervals: Interval[], minDepth: number): number {
  if (intervals.length === 0) return 0;

  const events: Array<{ at: number; delta: number }> = [];
  for (const i of intervals) {
    events.push({ at: i.start, delta: 1 });
    events.push({ at: i.end, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let depth = 0;
  let since = 0;
  let total = 0;

  for (const e of events) {
    if (depth >= minDepth && e.at > since) total += e.at - since;
    depth += e.delta;
    since = e.at;
  }
  return total / MS_PER_MINUTE;
}

export interface TechnicianLabour {
  technicianId: string;
  /** Minutes this technician was actually on the job, excluding their own idle gaps. */
  activeMinutes: number;
  segmentCount: number;
  /** True while one of their segments is still open. */
  stillActive: boolean;
}

export interface LabourMeasures {
  perTechnician: TechnicianLabour[];
  /** Sum of every technician's active minutes. Two people for an hour = 120. */
  teamLabourMinutes: number;
  /** Wall-clock during which at least one technician was working. */
  activeCoverageMinutes: number;
  /** Wall-clock during which two or more technicians were working at once. */
  concurrentAssistMinutes: number;
  /** Approved job-wide exclusion deducted from coverage — ONCE. */
  excludedCoverageMinutes: number;
  /** Coverage after the job-wide exclusion. */
  netCoverageMinutes: number;
  /** More than one technician contributed. */
  isShared: boolean;
  technicianCount: number;
}

/**
 * Compute every labour measure for one job.
 *
 * How exclusions are handled, and why it differs between the two kinds of measure:
 *
 *   Coverage is wall-clock, so an approved job-wide delay comes off it ONCE. This is
 *   the rule the CR calls out. Deducting a 30-minute parts wait from each of three
 *   technicians would erase 90 minutes of labour that 30 minutes of delay cannot
 *   justify.
 *
 *   Per-technician minutes come off only where the delay actually overlaps THAT
 *   technician's own segments. Usually there is no overlap at all, because pausing a
 *   job closes its segments — so the delayed time was never inside anyone's segment
 *   to begin with. The intersection is taken anyway, for the case where a delay is
 *   approved retrospectively over time a segment was left open.
 */
export function computeLabourMeasures(
  segments: readonly Segment[],
  exclusions: readonly ExclusionSpan[],
  now: Date,
): LabourMeasures {
  const exclusionIntervals = merge(toIntervals(exclusions, now));

  const byTech = new Map<string, Segment[]>();
  for (const s of segments) {
    const list = byTech.get(s.technicianId);
    if (list) list.push(s);
    else byTech.set(s.technicianId, [s]);
  }

  const perTechnician: TechnicianLabour[] = [];
  const allIntervals: Interval[] = [];

  for (const [technicianId, techSegments] of byTech) {
    const own = merge(toIntervals(techSegments, now));
    allIntervals.push(...own);

    const net = subtract(own, exclusionIntervals);
    perTechnician.push({
      technicianId,
      activeMinutes: Math.round(totalMs(net) / MS_PER_MINUTE),
      segmentCount: techSegments.length,
      stillActive: techSegments.some((s) => s.endedAt === null),
    });
  }

  perTechnician.sort((a, b) => b.activeMinutes - a.activeMinutes);

  const coverage = merge([...allIntervals].sort((a, b) => a.start - b.start));
  const coverageMinutes = totalMs(coverage) / MS_PER_MINUTE;
  const netCoverage = subtract(coverage, exclusionIntervals);
  const netCoverageMinutes = totalMs(netCoverage) / MS_PER_MINUTE;

  return {
    perTechnician,
    teamLabourMinutes: perTechnician.reduce((sum, t) => sum + t.activeMinutes, 0),
    activeCoverageMinutes: Math.round(coverageMinutes),
    concurrentAssistMinutes: Math.round(minutesAtDepth(allIntervals, 2)),
    excludedCoverageMinutes: Math.round(coverageMinutes - netCoverageMinutes),
    netCoverageMinutes: Math.round(netCoverageMinutes),
    isShared: byTech.size > 1,
    technicianCount: byTech.size,
  };
}
