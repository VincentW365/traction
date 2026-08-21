import { describe, it, expect } from 'vitest';
import {
  rateAbsoluteCompletion,
  rateAdjustedVariance,
  isOnTarget,
  minutesToNextBoundary,
} from '../engine/kpi-rating';
import {
  calculateKpi,
  mergedSpanMinutes,
  hasOverlap,
  type DelaySpan,
} from '../engine/kpi-calculation';
// Package detection has its own suite: kpi-package-detection.spec.ts

/**
 * CR-2026-088 — the KPI engine.
 *
 * The benchmark matrix these tests exercise (integer minutes throughout):
 *
 *              General Service   + Front Brakes   + Spark Plugs
 *   Sedan            90               120              150
 *   SUV             120               150              180
 *
 * SUV is Sedan + 30 at every package, which is what the manager's 1.5-2.0h sedan /
 * 2.0-2.5h SUV ranges come to.
 */

const SEDAN = { GENERAL: 90, BRAKES: 120, PLUGS: 150 };
const SUV = { GENERAL: 120, BRAKES: 150, PLUGS: 180 };

const at = (min: number) => new Date(Date.UTC(2026, 7, 21, 8, 0, 0) + min * 60_000);

/** Finish a job of `standardMinutes` in `actualMinutes` and read both ratings. */
function runJob(standardMinutes: number, actualMinutes: number, delays: DelaySpan[] = []) {
  return calculateKpi({
    firstWorkStartedAt: at(0),
    firstSubmittedToQcAt: at(actualMinutes),
    standardMinutes,
    delays,
  });
}

// ---------------------------------------------------------------------------
// Adjusted rating — the directive's worked examples, verbatim
// ---------------------------------------------------------------------------
describe('adjusted technician rating (scope-aware)', () => {
  it('Sedan General Service at 90 min → Excellent (exactly on standard)', () => {
    expect(runJob(SEDAN.GENERAL, 90).adjustedTechnicianRating).toBe('EXCELLENT');
  });

  it('Sedan General Service at 120 min → Meets Target (30 over)', () => {
    expect(runJob(SEDAN.GENERAL, 120).adjustedTechnicianRating).toBe('MEETS_TARGET');
  });

  it('Sedan General Service at 150 min → Needs Improvement (60 over)', () => {
    expect(runJob(SEDAN.GENERAL, 150).adjustedTechnicianRating).toBe('NEEDS_IMPROVEMENT');
  });

  it('Sedan General Service at 151 min → Below Standard (61 over)', () => {
    expect(runJob(SEDAN.GENERAL, 151).adjustedTechnicianRating).toBe('BELOW_STANDARD');
  });

  it('SUV General Service at 120 min → Excellent', () => {
    expect(runJob(SUV.GENERAL, 120).adjustedTechnicianRating).toBe('EXCELLENT');
  });

  it('SUV General Service at 150 min → Meets Target', () => {
    expect(runJob(SUV.GENERAL, 150).adjustedTechnicianRating).toBe('MEETS_TARGET');
  });

  it('rewards beating the standard, without inventing a band above Excellent', () => {
    expect(runJob(SUV.PLUGS, 90).adjustedTechnicianRating).toBe('EXCELLENT');
    expect(runJob(SEDAN.GENERAL, 1).adjustedTechnicianRating).toBe('EXCELLENT');
  });

  it('does not punish an SUV technician for the vehicle they were given', () => {
    // The exact unfairness the adjusted rating exists to fix: 120 minutes is a
    // perfect SUV general service and a mediocre sedan one.
    expect(runJob(SUV.GENERAL, 120).adjustedTechnicianRating).toBe('EXCELLENT');
    expect(runJob(SEDAN.GENERAL, 120).adjustedTechnicianRating).toBe('MEETS_TARGET');
  });
});

// ---------------------------------------------------------------------------
// Both ratings together
// ---------------------------------------------------------------------------
describe('absolute and adjusted ratings side by side', () => {
  it('Sedan General Service + Front Brakes at 120 min → both Excellent', () => {
    const r = runJob(SEDAN.BRAKES, 120);
    expect(r.absoluteCompletionRating).toBe('EXCELLENT');
    expect(r.adjustedTechnicianRating).toBe('EXCELLENT');
  });

  it('a 120-minute standard at 150 min → both Meets Target', () => {
    const r = runJob(120, 150);
    expect(r.absoluteCompletionRating).toBe('MEETS_TARGET');
    expect(r.adjustedTechnicianRating).toBe('MEETS_TARGET');
  });

  it('a 120-minute standard at 180 min → both Needs Improvement', () => {
    const r = runJob(120, 180);
    expect(r.absoluteCompletionRating).toBe('NEEDS_IMPROVEMENT');
    expect(r.adjustedTechnicianRating).toBe('NEEDS_IMPROVEMENT');
  });

  it('a 120-minute standard at 181 min → both Below Standard', () => {
    const r = runJob(120, 181);
    expect(r.absoluteCompletionRating).toBe('BELOW_STANDARD');
    expect(r.adjustedTechnicianRating).toBe('BELOW_STANDARD');
  });

  it('keeps both results; neither overwrites the other', () => {
    // SUV plugs finished in 170: excellent for the scope, but still past the
    // manager's absolute 151-180 band. Management must be able to see both.
    const r = runJob(SUV.PLUGS, 170);
    expect(r.adjustedTechnicianRating).toBe('EXCELLENT');
    expect(r.absoluteCompletionRating).toBe('NEEDS_IMPROVEMENT');
  });

  it('SUV General Service + Front Brakes + Spark Plugs uses a 180-minute standard', () => {
    expect(SUV.PLUGS).toBe(180);
    expect(runJob(SUV.PLUGS, 180).varianceMinutes).toBe(0);
    expect(runJob(SUV.PLUGS, 180).adjustedTechnicianRating).toBe('EXCELLENT');
  });
});

// ---------------------------------------------------------------------------
// Absolute bands on their own
// ---------------------------------------------------------------------------
describe('absolute completion rating', () => {
  it('applies the manager’s table with inclusive upper bounds', () => {
    expect(rateAbsoluteCompletion(120)).toBe('EXCELLENT');
    expect(rateAbsoluteCompletion(121)).toBe('MEETS_TARGET');
    expect(rateAbsoluteCompletion(150)).toBe('MEETS_TARGET');
    expect(rateAbsoluteCompletion(151)).toBe('NEEDS_IMPROVEMENT');
    expect(rateAbsoluteCompletion(180)).toBe('NEEDS_IMPROVEMENT');
    expect(rateAbsoluteCompletion(181)).toBe('BELOW_STANDARD');
  });

  it('returns null when there is no time to rate', () => {
    // "No work recorded" must never read as Excellent.
    for (const v of [null, undefined, 0, -5, Number.NaN]) {
      expect(rateAbsoluteCompletion(v as number)).toBeNull();
    }
  });
});

describe('variance rating boundaries', () => {
  it('uses integer-minute logic consistently', () => {
    expect(rateAdjustedVariance(0)).toBe('EXCELLENT');
    expect(rateAdjustedVariance(1)).toBe('MEETS_TARGET');
    expect(rateAdjustedVariance(30)).toBe('MEETS_TARGET');
    expect(rateAdjustedVariance(31)).toBe('NEEDS_IMPROVEMENT');
    expect(rateAdjustedVariance(60)).toBe('NEEDS_IMPROVEMENT');
    expect(rateAdjustedVariance(61)).toBe('BELOW_STANDARD');
    expect(rateAdjustedVariance(-1)).toBe('EXCELLENT');
  });

  it('marks Excellent and Meets Target as on target, and the rest not', () => {
    expect(isOnTarget('EXCELLENT')).toBe(true);
    expect(isOnTarget('MEETS_TARGET')).toBe(true);
    expect(isOnTarget('NEEDS_IMPROVEMENT')).toBe(false);
    expect(isOnTarget('BELOW_STANDARD')).toBe(false);
    expect(isOnTarget(null)).toBe(false);
  });

  it('reports how long until the next boundary, for the live technician card', () => {
    // 12 minutes over standard: Meets Target, 19 minutes before Needs Improvement.
    expect(minutesToNextBoundary(12)).toEqual({
      nextRating: 'NEEDS_IMPROVEMENT',
      minutesRemaining: 19,
    });
    // Already in the bottom band — there is no next boundary.
    expect(minutesToNextBoundary(90)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delays and exclusions
// ---------------------------------------------------------------------------
describe('approved delays', () => {
  const delay = (
    fromMin: number,
    toMin: number,
    approvalStatus: DelaySpan['approvalStatus'],
    requestedForExclusion = true,
  ): DelaySpan => ({
    startedAt: at(fromMin),
    endedAt: at(toMin),
    approvalStatus,
    requestedForExclusion,
  });

  it('removes an approved 20-minute delay from KPI time but not from elapsed', () => {
    const r = runJob(SEDAN.GENERAL, 110, [delay(30, 50, 'APPROVED')]);
    expect(r.rawElapsedMinutes).toBe(110); // total cycle time is untouched
    expect(r.approvedExcludedMinutes).toBe(20);
    expect(r.kpiCompletionMinutes).toBe(90);
    expect(r.adjustedTechnicianRating).toBe('EXCELLENT');
  });

  it('does not remove an unapproved delay', () => {
    const pending = runJob(SEDAN.GENERAL, 110, [delay(30, 50, 'PENDING')]);
    expect(pending.approvedExcludedMinutes).toBe(0);
    expect(pending.kpiCompletionMinutes).toBe(110);

    const rejected = runJob(SEDAN.GENERAL, 110, [delay(30, 50, 'REJECTED')]);
    expect(rejected.approvedExcludedMinutes).toBe(0);
  });

  it('does not remove a recorded delay that was never requested for exclusion', () => {
    // A technician may log a delay for the record without claiming KPI relief.
    const r = runJob(SEDAN.GENERAL, 110, [delay(30, 50, 'APPROVED', false)]);
    expect(r.approvedExcludedMinutes).toBe(0);
  });

  it('never double-counts overlapping delays', () => {
    // Two overlapping 20-minute delays are 30 minutes of wall clock, not 40.
    const r = runJob(SEDAN.GENERAL, 130, [
      delay(20, 40, 'APPROVED'),
      delay(30, 50, 'APPROVED'),
    ]);
    expect(r.approvedExcludedMinutes).toBe(30);
    expect(r.kpiCompletionMinutes).toBe(100);
  });

  it('cannot exclude more time than the job took', () => {
    const r = runJob(SEDAN.GENERAL, 30, [delay(0, 120, 'APPROVED')]);
    expect(r.approvedExcludedMinutes).toBe(30);
    expect(r.kpiCompletionMinutes).toBe(0);
  });

  it('shows raw, excluded and adjusted time so the result can be checked', () => {
    const r = runJob(SEDAN.GENERAL, 110, [delay(30, 50, 'APPROVED')]);
    expect(r.rawElapsedMinutes! - r.approvedExcludedMinutes).toBe(r.kpiCompletionMinutes);
  });
});

describe('span helpers', () => {
  it('merges touching and overlapping spans', () => {
    expect(
      mergedSpanMinutes([
        { startedAt: at(0), endedAt: at(10) },
        { startedAt: at(10), endedAt: at(20) },
      ]),
    ).toBe(20);
  });

  it('ignores spans that never closed when no bound is given', () => {
    expect(mergedSpanMinutes([{ startedAt: at(0), endedAt: null }])).toBe(0);
  });

  it('detects overlap, so a duplicate segment cannot be saved', () => {
    expect(
      hasOverlap([
        { startedAt: at(0), endedAt: at(30) },
        { startedAt: at(20), endedAt: at(40) },
      ]),
    ).toBe(true);
    expect(
      hasOverlap([
        { startedAt: at(0), endedAt: at(30) },
        { startedAt: at(30), endedAt: at(40) },
      ]),
    ).toBe(false);
  });

  it('treats a still-open span as overlapping anything after it', () => {
    expect(
      hasOverlap([
        { startedAt: at(0), endedAt: null },
        { startedAt: at(20), endedAt: at(40) },
      ]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clock definition
// ---------------------------------------------------------------------------
describe('what the KPI clock measures', () => {
  it('measures start-of-work to first submit-to-QC, nothing earlier', () => {
    const r = calculateKpi({
      firstWorkStartedAt: at(60), // the car had been on site an hour by now
      firstSubmittedToQcAt: at(150),
      standardMinutes: SEDAN.GENERAL,
    });
    expect(r.rawElapsedMinutes).toBe(90);
    expect(r.adjustedTechnicianRating).toBe('EXCELLENT');
  });

  it('reports nothing for a job that never started', () => {
    const r = calculateKpi({
      firstWorkStartedAt: null,
      firstSubmittedToQcAt: null,
      standardMinutes: SEDAN.GENERAL,
    });
    expect(r.kpiCompletionMinutes).toBeNull();
    expect(r.adjustedTechnicianRating).toBeNull();
    expect(r.onTarget).toBe(false);
  });

  it('measures an in-flight job to now, and says so', () => {
    const r = calculateKpi({
      firstWorkStartedAt: at(0),
      firstSubmittedToQcAt: null,
      standardMinutes: SEDAN.GENERAL,
      now: at(45),
    });
    expect(r.inFlight).toBe(true);
    expect(r.kpiCompletionMinutes).toBe(45);
    expect(r.varianceMinutes).toBe(-45);
  });

  it('refuses to rate a negative span rather than reporting a flattering number', () => {
    const r = calculateKpi({
      firstWorkStartedAt: at(100),
      firstSubmittedToQcAt: at(10),
      standardMinutes: SEDAN.GENERAL,
    });
    expect(r.kpiCompletionMinutes).toBeNull();
    expect(r.adjustedTechnicianRating).toBeNull();
  });

  it('rounds up once, at the end, not per segment', () => {
    const r = calculateKpi({
      firstWorkStartedAt: new Date(Date.UTC(2026, 7, 21, 8, 0, 0)),
      firstSubmittedToQcAt: new Date(Date.UTC(2026, 7, 21, 9, 30, 30)), // 90m30s
      standardMinutes: SEDAN.GENERAL,
    });
    expect(r.rawElapsedMinutes).toBe(91);
  });

  it('reports variance in minutes and as a percentage', () => {
    const r = runJob(120, 150);
    expect(r.varianceMinutes).toBe(30);
    expect(r.minutesOverStandard).toBe(30);
    expect(r.minutesUnderStandard).toBe(0);
    expect(r.variancePercent).toBe(25);
  });
});

describe('custom, unbenchmarked jobs', () => {
  it('gets no automatic technician rating without a standard', () => {
    const r = calculateKpi({
      firstWorkStartedAt: at(0),
      firstSubmittedToQcAt: at(100),
      standardMinutes: null,
    });
    expect(r.adjustedTechnicianRating).toBeNull();
    expect(r.varianceMinutes).toBeNull();
    expect(r.onTarget).toBe(false);
    // The absolute band still applies — it needs no benchmark.
    expect(r.absoluteCompletionRating).toBe('EXCELLENT');
  });
});

