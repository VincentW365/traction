/**
 * CR-2026-099 — the priority queue engine, made real.
 *
 * Deterministic, auditable ranking per docs/08 and CLAUDE.md §5. Replaces the
 * plain FIFO ordering that ran while the priority settings sat decorative:
 *
 *   1. Hard constraints keep their existing semantics: BLOCKED tickets step
 *      aside (no position), pinned manager overrides take their requested
 *      position exactly as before.
 *   2. Everything else is classified and scored:
 *        class base weight  (base_weight_* business rules)
 *      + wait-time bonus    (wait_time_bonus_per_min, capped at wait_time_bonus_cap_min)
 *      − lateness penalty   (lateness_penalty_per_min, late appointments only)
 *      Sorted score DESC; ties by check-in order, so equal footing preserves
 *      arrival fairness and two same-class arrivals never leapfrog each other
 *      (the wait bonus grows at the same rate for everyone).
 *   3. Every decision carries reason codes so a manager can answer "why is
 *      this car ahead of that one" from the record, not from folklore.
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
  latenessPenaltyPerMin: number;
  waitTimeBonusPerMin: number;
  waitTimeBonusCapMin: number;
  baseWeights: Record<Exclude<PriorityClass, 'MANUAL_OVERRIDE' | 'MISSED_APPOINTMENT'>, number>;
}

/** Single source of the defaults — identical to the seeded business rules. */
export const PRIORITY_RULE_DEFAULTS: PriorityRuleConfig = {
  protectedWindowEarlyMin: 30,
  protectedWindowLateMin: 15,
  missedThresholdMin: 30,
  latenessPenaltyPerMin: 3,
  waitTimeBonusPerMin: 2,
  waitTimeBonusCapMin: 120,
  baseWeights: {
    APPT_PROTECTED: 1000,
    APPT_LATE_SOFT: 800,
    WALKIN_STANDARD: 600,
    WALKIN_FASTTRACK: 650,
  },
};

/** Business-rule keys the engine reads (used by the loader and by tests). */
export const PRIORITY_RULE_KEYS = [
  'protected_window_early_min',
  'protected_window_late_min',
  'missed_threshold_min',
  'lateness_penalty_per_min',
  'wait_time_bonus_per_min',
  'wait_time_bonus_cap_min',
  'base_weight_APPT_PROTECTED',
  'base_weight_APPT_LATE_SOFT',
  'base_weight_WALKIN_STANDARD',
  'base_weight_WALKIN_FASTTRACK',
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
    latenessPenaltyPerMin: num('lateness_penalty_per_min', d.latenessPenaltyPerMin),
    waitTimeBonusPerMin: num('wait_time_bonus_per_min', d.waitTimeBonusPerMin),
    waitTimeBonusCapMin: num('wait_time_bonus_cap_min', d.waitTimeBonusCapMin),
    baseWeights: {
      APPT_PROTECTED: num('base_weight_APPT_PROTECTED', d.baseWeights.APPT_PROTECTED),
      APPT_LATE_SOFT: num('base_weight_APPT_LATE_SOFT', d.baseWeights.APPT_LATE_SOFT),
      WALKIN_STANDARD: num('base_weight_WALKIN_STANDARD', d.baseWeights.WALKIN_STANDARD),
      WALKIN_FASTTRACK: num('base_weight_WALKIN_FASTTRACK', d.baseWeights.WALKIN_FASTTRACK),
    },
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

function scoreTicket(
  t: PriorityTicket,
  cls: Exclude<PriorityClass, 'MANUAL_OVERRIDE'>,
  now: Date,
  cfg: PriorityRuleConfig,
  reasons: ReasonCode[],
): number {
  // MISSED appointments rank as standard walk-ins — the label stays honest.
  const weightClass = cls === 'MISSED_APPOINTMENT' ? 'WALKIN_STANDARD' : cls;
  const base = cfg.baseWeights[weightClass];
  const CLASS_LABELS: Record<string, string> = {
    APPT_PROTECTED: 'On-time appointment',
    APPT_LATE_SOFT: 'Late appointment',
    WALKIN_STANDARD: 'Walk-in',
    WALKIN_FASTTRACK: 'Fast track',
  };
  reasons.push({ code: 'BASE_WEIGHT', detail: `${CLASS_LABELS[weightClass] ?? weightClass} base weight ${base}` });

  let score = base;

  const waitMin = t.checkedInAt ? Math.max(0, (now.getTime() - t.checkedInAt.getTime()) / 60000) : 0;
  const bonusMin = Math.min(waitMin, cfg.waitTimeBonusCapMin);
  const waitBonus = Math.round(bonusMin * cfg.waitTimeBonusPerMin);
  if (waitBonus > 0) {
    score += waitBonus;
    reasons.push({
      code: 'WAIT_BONUS',
      detail: `+${waitBonus} for ${Math.round(waitMin)} min waiting (${cfg.waitTimeBonusPerMin}/min, capped at ${cfg.waitTimeBonusCapMin} min)`,
    });
  }

  if (cls === 'APPT_LATE_SOFT' && t.scheduledStartAt && t.checkedInAt) {
    const lateMin = Math.max(0, (t.checkedInAt.getTime() - t.scheduledStartAt.getTime()) / 60000 - cfg.protectedWindowLateMin);
    const penalty = Math.round(lateMin * cfg.latenessPenaltyPerMin);
    if (penalty > 0) {
      score -= penalty;
      reasons.push({ code: 'LATENESS_PENALTY', detail: `−${penalty} for ${Math.round(lateMin)} min beyond the grace window` });
    }
  }

  return score;
}

/**
 * Rank all active tickets. Input order does not matter; ties break by
 * checkinSequence so equal-priority arrivals keep their arrival order.
 */
export function calculatePriorityPositions(
  tickets: PriorityTicket[],
  now: Date,
  cfg: PriorityRuleConfig = PRIORITY_RULE_DEFAULTS,
): PriorityResult[] {
  const pinned: PriorityTicket[] = [];
  const eligible: Array<{ t: PriorityTicket; cls: Exclude<PriorityClass, 'MANUAL_OVERRIDE'>; score: number; reasons: ReasonCode[] }> = [];
  const blocked: PriorityTicket[] = [];

  for (const t of tickets) {
    if (t.displayStatus === 'BLOCKED') {
      blocked.push(t);
    } else if (t.overrideActive && t.overrideRankPosition != null) {
      pinned.push(t);
    } else {
      const { cls, reasons } = classify(t, now, cfg);
      const score = scoreTicket(t, cls, now, cfg, reasons);
      eligible.push({ t, cls, score, reasons });
    }
  }

  eligible.sort((a, b) => b.score - a.score || a.t.checkinSequence - b.t.checkinSequence);
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
        score: e.score,
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
