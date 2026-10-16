import { describe, it, expect } from 'vitest';
import { jobClock } from '../job-clock';

/**
 * CR-2026-125 — a technician's clock stops when the work is handed to Quality
 * Check. The screen may stay open for an hour; the figure must not move.
 */
const T0 = Date.parse('2026-10-16T13:00:00Z');
const min = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('a live job', () => {
  it('counts from the start to now', () => {
    const c = jobClock({ startedAt: iso(T0), pausedMs: 0, openPauseStartedAt: null }, T0 + min(25));
    expect(c.started).toBe(true);
    expect(c.finished).toBe(false);
    expect(c.elapsedMs).toBe(min(25));
    expect(c.workingMs).toBe(min(25));
  });

  it('takes closed pauses and the open pause off the working figure, not off elapsed', () => {
    const c = jobClock(
      { startedAt: iso(T0), pausedMs: min(5), openPauseStartedAt: iso(T0 + min(20)) },
      T0 + min(30),
    );
    expect(c.elapsedMs).toBe(min(30));
    expect(c.workingMs).toBe(min(30) - min(5) - min(10));
  });
});

describe('a job sent to Quality Check', () => {
  const sent = { startedAt: iso(T0), completedAt: iso(T0 + min(40)), pausedMs: min(5), openPauseStartedAt: null };

  it('stops at the hand-off, whatever the time on the screen', () => {
    const atHandOff = jobClock(sent, T0 + min(40));
    const anHourLater = jobClock(sent, T0 + min(100));
    expect(atHandOff.finished).toBe(true);
    expect(atHandOff.elapsedMs).toBe(min(40));
    expect(atHandOff.workingMs).toBe(min(35));
    // The whole point: no movement after completion.
    expect(anHourLater.elapsedMs).toBe(atHandOff.elapsedMs);
    expect(anHourLater.workingMs).toBe(atHandOff.workingMs);
    expect(anHourLater.endMs).toBe(T0 + min(40));
  });

  it('is unaffected by a clock that is behind the server', () => {
    // A tablet whose clock runs a few minutes slow must not show a negative or
    // shrinking figure for a job the server says is finished.
    const c = jobClock(sent, T0 + min(38));
    expect(c.elapsedMs).toBe(min(40));
  });
});

describe('nothing to show', () => {
  it('is all zeros before the job has started', () => {
    expect(jobClock({ startedAt: null, pausedMs: 0, openPauseStartedAt: null }, T0)).toEqual({
      started: false,
      finished: false,
      elapsedMs: 0,
      workingMs: 0,
      endMs: null,
    });
    expect(jobClock(null, T0).started).toBe(false);
  });

  it('never goes negative on bad data', () => {
    const c = jobClock({ startedAt: iso(T0 + min(10)), pausedMs: min(99), openPauseStartedAt: null }, T0);
    expect(c.elapsedMs).toBe(0);
    expect(c.workingMs).toBe(0);
  });
});
