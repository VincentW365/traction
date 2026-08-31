import { describe, it, expect } from 'vitest';
import {
  calculatePriorityPositions,
  configFromRules,
  PRIORITY_RULE_DEFAULTS,
  PriorityTicket,
} from '../engine/priority-position.calculator';

/**
 * CR-2026-099 — the priority engine, pinned against the realistic combinations
 * from the go-live directive. All times relative to NOW for determinism.
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

describe('priority classes', () => {
  it('an appointment inside the protected window beats an earlier-arrived walk-in', () => {
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1, checkedInAt: min(-40) });
    const appt = ticket({ queueTicketId: 'appt', checkinSequence: 2, checkedInAt: min(-5), scheduledStartAt: min(0) });
    const r = calculatePriorityPositions([walkin, appt], NOW);
    expect(order(r)).toEqual(['appt', 'walkin']);
    const apptR = r.find((x) => x.queueTicketId === 'appt')!;
    expect(apptR.priorityClass).toBe('APPT_PROTECTED');
    expect(apptR.reasons.some((x) => x.code === 'APPT_ON_TIME')).toBe(true);
  });

  it('a very early appointment waits like a walk-in (protection has not started)', () => {
    // Slot is 2 hours away; arrived now — far before the 30-min protection window.
    const early = ticket({ queueTicketId: 'early', checkinSequence: 2, checkedInAt: min(0), scheduledStartAt: min(120) });
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1, checkedInAt: min(-30) });
    const r = calculatePriorityPositions([early, walkin], NOW);
    const earlyR = r.find((x) => x.queueTicketId === 'early')!;
    expect(earlyR.priorityClass).toBe('WALKIN_STANDARD');
    expect(earlyR.reasons.some((x) => x.code === 'EARLY_ARRIVAL')).toBe(true);
    // The walk-in has been waiting longer → stays ahead.
    expect(order(r)).toEqual(['walkin', 'early']);
  });

  it('a late appointment keeps soft priority over walk-ins but below protected, with a lateness penalty', () => {
    const late = ticket({ queueTicketId: 'late', checkinSequence: 3, checkedInAt: min(-2), scheduledStartAt: min(-22) }); // 22 min late (grace 15)
    const prot = ticket({ queueTicketId: 'prot', checkinSequence: 2, checkedInAt: min(-2), scheduledStartAt: min(5) });
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1, checkedInAt: min(-15) });
    const r = calculatePriorityPositions([late, prot, walkin], NOW);
    expect(order(r)).toEqual(['prot', 'late', 'walkin']);
    const lateR = r.find((x) => x.queueTicketId === 'late')!;
    expect(lateR.priorityClass).toBe('APPT_LATE_SOFT');
    expect(lateR.reasons.some((x) => x.code === 'LATENESS_PENALTY')).toBe(true);
  });

  it('past the missed threshold the appointment ranks as a walk-in, honestly labelled', () => {
    const missed = ticket({ queueTicketId: 'missed', checkinSequence: 2, checkedInAt: min(0), scheduledStartAt: min(-45) }); // 45 min late (threshold 30)
    const walkin = ticket({ queueTicketId: 'walkin', checkinSequence: 1, checkedInAt: min(-20) });
    const r = calculatePriorityPositions([missed, walkin], NOW);
    const missedR = r.find((x) => x.queueTicketId === 'missed')!;
    expect(missedR.priorityClass).toBe('MISSED_APPOINTMENT');
    // Walk-in arrived earlier and has the wait bonus → ahead.
    expect(order(r)).toEqual(['walkin', 'missed']);
  });

  it('fast-track walk-in (all quick services) overtakes a standard walk-in of similar wait', () => {
    const std = ticket({ queueTicketId: 'std', checkinSequence: 1, checkedInAt: min(-12) });
    const fast = ticket({ queueTicketId: 'fast', checkinSequence: 2, checkedInAt: min(-10), allQuickService: true });
    const r = calculatePriorityPositions([std, fast], NOW);
    expect(order(r)).toEqual(['fast', 'std']);
    expect(r.find((x) => x.queueTicketId === 'fast')!.priorityClass).toBe('WALKIN_FASTTRACK');
  });

  it('fast-track can never displace a protected appointment', () => {
    const fast = ticket({ queueTicketId: 'fast', checkinSequence: 1, checkedInAt: min(-120), allQuickService: true }); // max wait bonus
    const prot = ticket({ queueTicketId: 'prot', checkinSequence: 2, checkedInAt: min(-1), scheduledStartAt: min(0) });
    const r = calculatePriorityPositions([fast, prot], NOW);
    // 650 + 240 = 890 < 1000 — protection holds by construction of the defaults.
    expect(order(r)).toEqual(['prot', 'fast']);
  });
});

describe('fairness and ties', () => {
  it('equal-class arrivals keep strict arrival order (wait bonus grows equally)', () => {
    const a = ticket({ queueTicketId: 'a', checkinSequence: 1, checkedInAt: min(-30) });
    const b = ticket({ queueTicketId: 'b', checkinSequence: 2, checkedInAt: min(-30) });
    const c = ticket({ queueTicketId: 'c', checkinSequence: 3, checkedInAt: min(-30) });
    expect(order(calculatePriorityPositions([c, a, b], NOW))).toEqual(['a', 'b', 'c']);
  });

  it('a long-waiting walk-in eventually overtakes a freshly-late appointment', () => {
    // Walk-in waited 2h (600+240=840); late appt just arrived, 20 min late:
    // 800 − 15 penalty + 0 wait = 785 → the fairness escalation wins.
    const patient = ticket({ queueTicketId: 'patient', checkinSequence: 1, checkedInAt: min(-120) });
    const late = ticket({ queueTicketId: 'late', checkinSequence: 2, checkedInAt: min(0), scheduledStartAt: min(-20) });
    expect(order(calculatePriorityPositions([patient, late], NOW))).toEqual(['patient', 'late']);
  });
});

describe('overrides and blocking (existing semantics preserved)', () => {
  it('a manager override pins its exact position regardless of class', () => {
    const prot = ticket({ queueTicketId: 'prot', checkinSequence: 1, checkedInAt: min(-2), scheduledStartAt: min(0) });
    const pinned = ticket({ queueTicketId: 'pinned', checkinSequence: 2, overrideActive: true, overrideRankPosition: 1 });
    const r = calculatePriorityPositions([prot, pinned], NOW);
    expect(order(r)).toEqual(['pinned', 'prot']);
    const p = r.find((x) => x.queueTicketId === 'pinned')!;
    expect(p.priorityClass).toBe('MANUAL_OVERRIDE');
    expect(p.isOverride).toBe(true);
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

  it('several arrivals at once rank deterministically: protected, late-soft, fast-track, walk-ins', () => {
    const r = calculatePriorityPositions([
      ticket({ queueTicketId: 'w1', checkinSequence: 1, checkedInAt: min(-25) }),
      ticket({ queueTicketId: 'fast', checkinSequence: 2, checkedInAt: min(-20), allQuickService: true }),
      ticket({ queueTicketId: 'prot', checkinSequence: 3, checkedInAt: min(-10), scheduledStartAt: min(-5) }),
      ticket({ queueTicketId: 'late', checkinSequence: 4, checkedInAt: min(-5), scheduledStartAt: min(-25) }),
      ticket({ queueTicketId: 'w2', checkinSequence: 5, checkedInAt: min(-5) }),
    ], NOW);
    expect(order(r)).toEqual(['prot', 'late', 'fast', 'w1', 'w2']);
  });
});

describe('configuration', () => {
  it('reads live business-rule values and falls back to seeded defaults', () => {
    const cfg = configFromRules([
      { ruleKey: 'protected_window_late_min', valueJson: 25 },
      { ruleKey: 'base_weight_WALKIN_FASTTRACK', valueJson: 900 },
      { ruleKey: 'wait_time_bonus_per_min', valueJson: 'garbage' },
    ]);
    expect(cfg.protectedWindowLateMin).toBe(25);
    expect(cfg.baseWeights.WALKIN_FASTTRACK).toBe(900);
    expect(cfg.waitTimeBonusPerMin).toBe(PRIORITY_RULE_DEFAULTS.waitTimeBonusPerMin);
  });

  it('a manager raising the fast-track weight actually changes the order', () => {
    const prot = ticket({ queueTicketId: 'prot', checkinSequence: 1, checkedInAt: min(-2), scheduledStartAt: min(0) });
    const fast = ticket({ queueTicketId: 'fast', checkinSequence: 2, checkedInAt: min(-2), allQuickService: true });
    const boosted = configFromRules([{ ruleKey: 'base_weight_WALKIN_FASTTRACK', valueJson: 1500 }]);
    expect(order(calculatePriorityPositions([prot, fast], NOW, boosted))).toEqual(['fast', 'prot']);
  });
});
