import { describe, it, expect } from 'vitest';
import {
  calculatePriorityPositions,
  configFromRules,
  PRIORITY_RULE_DEFAULTS,
  PriorityTicket,
} from '../engine/priority-position.calculator';

/**
 * CR-2026-099b — FIFO-first queue: arrival order is the rule; priority
 * intervenes only for the complex cases (on-time appointment, manager
 * override, blocked car). Classes stay recorded for the board and the audit
 * trail but do not reorder the line.
 */

const NOW = new Date('2026-08-31T14:00:00Z');
const min = (m: number) => new Date(NOW.getTime() + m * 60000);

let seq = 0;
function ticket(over: Partial<PriorityTicket> = {}): PriorityTicket {
  return {
    queueTicketId: `qt-${++seq}`,
    serviceVisitId: `sv-${seq}`,
    checkinSequence: seq,
    displayStatus: 'WAITING',
    overrideActive: false,
    overrideRankPosition: null,
    blockedReason: null,
    checkedInAt: min(-10),
    scheduledStartAt: null,
    allQuickService: false,
    ...over,
  };
}

const order = (results: ReturnType<typeof calculatePriorityPositions>) =>
  results.filter((r) => r.position !== null).sort((a, b) => a.position! - b.position!).map((r) => r.queueTicketId);

describe('FIFO baseline', () => {
  it('walk-ins rank strictly by arrival order', () => {
    const a = ticket({ queueTicketId: 'a', checkinSequence: 1 });
    const b = ticket({ queueTicketId: 'b', checkinSequence: 2 });
    const c = ticket({ queueTicketId: 'c', checkinSequence: 3 });
    expect(order(calculatePriorityPositions([c, a, b], NOW))).toEqual(['a', 'b', 'c']);
  });

  it('a quick-service walk-in does NOT overtake — fast-track is a label, not a queue jump', () => {
    const std = ticket({ queueTicketId: 'std', checkinSequence: 1 });
    const fast = ticket({ queueTicketId: 'fast', checkinSequence: 2, allQuickService: true });
    const r = calculatePriorityPositions([std, fast], NOW);
    expect(order(r)).toEqual(['std', 'fast']);
    expect(r.find((x) => x.queueTicketId === 'fast')!.priorityClass).toBe('WALKIN_FASTTRACK');
  });

  it('a late appointment takes plain FIFO order by its check-in, honestly labelled', () => {
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1, checkedInAt: min(-15) });
    const late = ticket({ queueTicketId: 'late', checkinSequence: 2, checkedInAt: min(-2), scheduledStartAt: min(-22) });
    const r = calculatePriorityPositions([late, walkin], NOW);
    expect(order(r)).toEqual(['walkin', 'late']);
    expect(r.find((x) => x.queueTicketId === 'late')!.priorityClass).toBe('APPT_LATE_SOFT');
  });

  it('a missed appointment ranks FIFO like any walk-in, labelled MISSED', () => {
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1 });
    const missed = ticket({ queueTicketId: 'missed', checkinSequence: 2, checkedInAt: min(0), scheduledStartAt: min(-45) });
    const r = calculatePriorityPositions([missed, walkin], NOW);
    expect(order(r)).toEqual(['walkin', 'missed']);
    expect(r.find((x) => x.queueTicketId === 'missed')!.priorityClass).toBe('MISSED_APPOINTMENT');
  });

  it('a very early appointment waits in the walk-in line until its window opens', () => {
    const early = ticket({ queueTicketId: 'early', checkinSequence: 2, checkedInAt: min(0), scheduledStartAt: min(120) });
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1 });
    const r = calculatePriorityPositions([early, walkin], NOW);
    expect(order(r)).toEqual(['walkin', 'early']);
    const earlyR = r.find((x) => x.queueTicketId === 'early')!;
    expect(earlyR.priorityClass).toBe('WALKIN_STANDARD');
    expect(earlyR.reasons.some((x) => x.code === 'EARLY_ARRIVAL')).toBe(true);
  });
});

describe('priority interventions (the complex cases)', () => {
  it('an on-time appointment goes ahead of the walk-in line', () => {
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1, checkedInAt: min(-40) });
    const appt = ticket({ queueTicketId: 'appt', checkinSequence: 2, checkedInAt: min(-5), scheduledStartAt: min(0) });
    const r = calculatePriorityPositions([walkin, appt], NOW);
    expect(order(r)).toEqual(['appt', 'walkin']);
    const apptR = r.find((x) => x.queueTicketId === 'appt')!;
    expect(apptR.priorityClass).toBe('APPT_PROTECTED');
    expect(apptR.reasons.some((x) => x.code === 'PROTECTED_AHEAD')).toBe(true);
  });

  it('two on-time appointments keep their own arrival order', () => {
    const a1 = ticket({ queueTicketId: 'a1', checkinSequence: 3, checkedInAt: min(-5), scheduledStartAt: min(0) });
    const a2 = ticket({ queueTicketId: 'a2', checkinSequence: 4, checkedInAt: min(-3), scheduledStartAt: min(10) });
    const w = ticket({ queueTicketId: 'w', checkinSequence: 1 });
    expect(order(calculatePriorityPositions([a2, w, a1], NOW))).toEqual(['a1', 'a2', 'w']);
  });

  it('a manager override pins its exact position above everything', () => {
    const appt = ticket({ queueTicketId: 'appt', checkinSequence: 1, checkedInAt: min(-2), scheduledStartAt: min(0) });
    const pinned = ticket({ queueTicketId: 'pinned', checkinSequence: 2, overrideActive: true, overrideRankPosition: 1 });
    const r = calculatePriorityPositions([appt, pinned], NOW);
    expect(order(r)).toEqual(['pinned', 'appt']);
    expect(r.find((x) => x.queueTicketId === 'pinned')!.priorityClass).toBe('MANUAL_OVERRIDE');
  });

  it('blocked tickets step aside with no position and keep their reason', () => {
    const blocked = ticket({ queueTicketId: 'blocked', displayStatus: 'BLOCKED', blockedReason: 'Waiting for parts' });
    const ok = ticket({ queueTicketId: 'ok' });
    const r = calculatePriorityPositions([blocked, ok], NOW);
    const b = r.find((x) => x.queueTicketId === 'blocked')!;
    expect(b.position).toBeNull();
    expect(b.blockedReason).toBe('Waiting for parts');
    expect(order(r)).toEqual(['ok']);
  });

  it('a busy mixed line: protected appointments first (by arrival), then pure FIFO', () => {
    const r = calculatePriorityPositions([
      ticket({ queueTicketId: 'w1', checkinSequence: 1, checkedInAt: min(-25) }),
      ticket({ queueTicketId: 'fast', checkinSequence: 2, checkedInAt: min(-20), allQuickService: true }),
      ticket({ queueTicketId: 'prot', checkinSequence: 3, checkedInAt: min(-10), scheduledStartAt: min(-5) }),
      ticket({ queueTicketId: 'late', checkinSequence: 4, checkedInAt: min(-5), scheduledStartAt: min(-25) }),
      ticket({ queueTicketId: 'w2', checkinSequence: 5, checkedInAt: min(-5) }),
    ], NOW);
    expect(order(r)).toEqual(['prot', 'w1', 'fast', 'late', 'w2']);
  });
});

describe('configuration', () => {
  it('reads the window rules and falls back to seeded defaults', () => {
    const cfg = configFromRules([
      { ruleKey: 'protected_window_late_min', valueJson: 25 },
      { ruleKey: 'missed_threshold_min', valueJson: 'garbage' },
    ]);
    expect(cfg.protectedWindowLateMin).toBe(25);
    expect(cfg.missedThresholdMin).toBe(PRIORITY_RULE_DEFAULTS.missedThresholdMin);
  });

  it('widening the late window is a real control: a 20-min-late appointment becomes protected', () => {
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1, checkedInAt: min(-40) });
    const late = ticket({ queueTicketId: 'late', checkinSequence: 2, checkedInAt: min(0), scheduledStartAt: min(-20) });
    // Default late window (15) → FIFO behind the walk-in.
    expect(order(calculatePriorityPositions([walkin, late], NOW))).toEqual(['walkin', 'late']);
    // Manager widens the window to 25 → protected, goes ahead.
    const widened = configFromRules([{ ruleKey: 'protected_window_late_min', valueJson: 25 }]);
    expect(order(calculatePriorityPositions([walkin, late], NOW, widened))).toEqual(['late', 'walkin']);
  });
});
