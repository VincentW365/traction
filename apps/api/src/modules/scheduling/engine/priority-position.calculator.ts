/**
 * CR-2026-099b — FIFO-first queue with priority for the complex cases only.
 *
 * The owner's rule: arrival order IS the queue. Priority intervenes only when
 * something genuinely complicates the line:
 *
 *   1. BLOCKED tickets step aside (no position) — unchanged.
 *   2. MANUAL_OVERRIDE pins its exact position — unchanged.
 *   3. An appointment checked in INSIDE its protected window
 *      (−protected_window_early_min / +protected_window_late_min of the slot)
 *      goes ahead of the walk-in line — that is what booking a time means.
 *   4. Everyone else — walk-ins, early arrivals, late and missed appointments,
 *      quick services — ranks strictly by check-in order. Classes are still
 *      computed and recorded (the board chips and the audit trail stay honest)
 *      but they do not reorder the line.
 *
 * No scoring, no weights, no overtaking. Every decision still persists reason
 * codes to QueueDecision for the audit trail.
 *
 * Pure function — no database access; the caller supplies the rule config
 * (single source of defaults: PRIORITY_RULE_DEFAULTS, mirroring the seed).
 */

export type PriorityClass =
  | 'APPT_PROTECTED'
  | 'APPT_LATE_SOFT'
  | 'MISSED_APPOINTMENT'
  | 'WALKIN_STANDARD'
  | 'WALKIN_FASTTRACK'
  | 'MANUAL_OVERRIDE';

export interface PriorityRuleConfig {
  protectedWindowEarlyMin: number;
  protectedWindowLateMin: number;
  missedThresholdMin: number;
}

/** Single source of the defaults — identical to the seeded business rules. */
export const PRIORITY_RULE_DEFAULTS: PriorityRuleConfig = {
  protectedWindowEarlyMin: 30,
  protectedWindowLateMin: 15,
  missedThresholdMin: 30,
};

/** Business-rule keys the engine reads (used by the loader and by tests). */
export const PRIORITY_RULE_KEYS = [
  'protected_window_early_min',
  'protected_window_late_min',
  'missed_threshold_min',
] as const;

export function configFromRules(rules: Array<{ ruleKey: string; valueJson: unknown }>): PriorityRuleConfig {
  const num = (key: string, dflt: number): number => {
    const row = rules.find((r) => r.ruleKey === key);
    const v = Number(row?.valueJson);
    return Number.isFinite(v) ? v : dflt;
  };
  const d = PRIORITY_RULE_DEFAULTS;
  return {
    protectedWindowEarlyMin: num('protected_window_early_min', d.protectedWindowEarlyMin),
    protectedWindowLateMin: num('protected_window_late_min', d.protectedWindowLateMin),
    missedThresholdMin: num('missed_threshold_min', d.missedThresholdMin),
  };
}

export interface PriorityTicket {
  queueTicketId: string;
  serviceVisitId: string;
  checkinSequence: number;
  displayStatus: string;
  overrideActive: boolean;
  overrideRankPosition: number | null;
  blockedReason: string | null;
  /** When the customer checked in (wait time starts here). */
  checkedInAt: Date | null;
  /** Appointment slot, when the visit came from an appointment. */
  scheduledStartAt: Date | null;
  /** Every requested service is a quick service (fast-track candidate). */
  allQuickService: boolean;
}

export interface ReasonCode {
  code: string;
  detail: string;
}

export interface PriorityResult {
  queueTicketId: string;
  serviceVisitId: string;
  position: number | null; // null = blocked (stepped aside)
  displayStatus: string;
  blockedReason: string | null;
  priorityClass: PriorityClass | null; // null only for blocked tickets
  score: number | null;
  reasons: ReasonCode[];
  isOverride: boolean;
}

function classify(
  t: PriorityTicket,
  now: Date,
  cfg: PriorityRuleConfig,
): { cls: Exclude<PriorityClass, 'MANUAL_OVERRIDE'>; reasons: ReasonCode[] } {
  const reasons: ReasonCode[] = [];
  if (t.scheduledStartAt) {
    const deltaMin = ((t.checkedInAt ?? now).getTime() - t.scheduledStartAt.getTime()) / 60000;
    if (deltaMin <= -cfg.protectedWindowEarlyMin) {
      // Arrived before the protection window even opens: waits as a walk-in
      // until the window would have covered them — classified standard, the
      // reason records the early arrival.
      reasons.push({
        code: 'EARLY_ARRIVAL',
        detail: `Arrived ${Math.round(-deltaMin)} min before the appointment; protection starts ${cfg.protectedWindowEarlyMin} min before`,
      });
      return { cls: 'WALKIN_STANDARD', reasons };
    }
    if (deltaMin <= cfg.protectedWindowLateMin) {
      reasons.push({
        code: 'APPT_ON_TIME',
        detail: `Checked in within the protected window (−${cfg.protectedWindowEarlyMin}/+${cfg.protectedWindowLateMin} min of the slot)`,
      });
      return { cls: 'APPT_PROTECTED', reasons };
    }
    if (deltaMin <= cfg.missedThresholdMin) {
      reasons.push({
        code: 'APPT_LATE',
        detail: `Checked in ${Math.round(deltaMin)} min after the slot (soft priority up to ${cfg.missedThresholdMin} min)`,
      });
      return { cls: 'APPT_LATE_SOFT', reasons };
    }
    reasons.push({
      code: 'APPT_MISSED',
      detail: `Checked in ${Math.round(deltaMin)} min after the slot — treated as a walk-in`,
    });
    return { cls: 'MISSED_APPOINTMENT', reasons };
  }

  if (t.allQuickService) {
    reasons.push({ code: 'FAST_TRACK', detail: 'Every requested service is a quick service' });
    return { cls: 'WALKIN_FASTTRACK', reasons };
  }
  reasons.push({ code: 'WALK_IN', detail: 'Walk-in, ranked by arrival and wait time' });
  return { cls: 'WALKIN_STANDARD', reasons };
}

/**
 * Rank all active tickets, FIFO-first. Input order does not matter.
 * Protected appointments form the head of the line (among themselves by
 * arrival); everyone else follows in strict check-in order.
 */
export function calculatePriorityPositions(
  tickets: PriorityTicket[],
  now: Date,
  cfg: PriorityRuleConfig = PRIORITY_RULE_DEFAULTS,
): PriorityResult[] {
  const pinned: PriorityTicket[] = [];
  const eligible: Array<{ t: PriorityTicket; cls: Exclude<PriorityClass, 'MANUAL_OVERRIDE'>; reasons: ReasonCode[] }> = [];
  const blocked: PriorityTicket[] = [];

  for (const t of tickets) {
    if (t.displayStatus === 'BLOCKED') {
      blocked.push(t);
    } else if (t.overrideActive && t.overrideRankPosition != null) {
      pinned.push(t);
    } else {
      const { cls, reasons } = classify(t, now, cfg);
      if (cls === 'APPT_PROTECTED') {
        reasons.push({ code: 'PROTECTED_AHEAD', detail: 'On-time appointments go ahead of the walk-in line' });
      } else {
        reasons.push({ code: 'FIFO', detail: 'Ranked by arrival order' });
      }
      eligible.push({ t, cls, reasons });
    }
  }

  // FIFO baseline; the ONLY reordering is protected appointments to the front.
  eligible.sort((a, b) => {
    const aProt = a.cls === 'APPT_PROTECTED' ? 0 : 1;
    const bProt = b.cls === 'APPT_PROTECTED' ? 0 : 1;
    return aProt - bProt || a.t.checkinSequence - b.t.checkinSequence;
  });
  pinned.sort((a, b) => (a.overrideRankPosition ?? 999) - (b.overrideRankPosition ?? 999));

  const results: PriorityResult[] = [];
  let eligibleIdx = 0;
  let pinnedIdx = 0;
  let position = 1;

  while (pinnedIdx < pinned.length || eligibleIdx < eligible.length) {
    if (pinnedIdx < pinned.length && (pinned[pinnedIdx].overrideRankPosition ?? 999) <= position) {
      const p = pinned[pinnedIdx++];
      results.push({
        queueTicketId: p.queueTicketId,
        serviceVisitId: p.serviceVisitId,
        position: position++,
        displayStatus: p.displayStatus,
        blockedReason: null,
        priorityClass: 'MANUAL_OVERRIDE',
        score: null,
        reasons: [{ code: 'MANUAL_OVERRIDE', detail: `Manager pinned to position ${p.overrideRankPosition}` }],
        isOverride: true,
      });
    } else if (eligibleIdx < eligible.length) {
      const e = eligible[eligibleIdx++];
      results.push({
        queueTicketId: e.t.queueTicketId,
        serviceVisitId: e.t.serviceVisitId,
        position: position++,
        displayStatus: e.t.displayStatus,
        blockedReason: null,
        priorityClass: e.cls,
        score: null, // FIFO-first: no scoring (CR-2026-099b)
        reasons: e.reasons,
        isOverride: false,
      });
    } else {
      // Only pinned tickets remain, wanting positions beyond the queue length.
      const p = pinned[pinnedIdx++];
      results.push({
        queueTicketId: p.queueTicketId,
        serviceVisitId: p.serviceVisitId,
        position: position++,
        displayStatus: p.displayStatus,
        blockedReason: null,
        priorityClass: 'MANUAL_OVERRIDE',
        score: null,
        reasons: [{ code: 'MANUAL_OVERRIDE', detail: `Manager pinned to position ${p.overrideRankPosition}` }],
        isOverride: true,
      });
    }
  }

  for (const b of blocked) {
    results.push({
      queueTicketId: b.queueTicketId,
      serviceVisitId: b.serviceVisitId,
      position: null,
      displayStatus: 'BLOCKED',
      blockedReason: b.blockedReason,
      priorityClass: null,
      score: null,
      reasons: [{ code: 'BLOCKED', detail: b.blockedReason ?? 'Blocked' }],
      isOverride: false,
    });
  }

  return results;
}
