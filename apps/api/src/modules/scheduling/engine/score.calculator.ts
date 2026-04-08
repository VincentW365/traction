/**
 * Stage 4 — Score Calculator
 *
 * Computes a weighted numeric score for each eligible visit.
 * Higher score = higher queue position.
 *
 * Phase 1 formula:
 *   score = baseWeight + waitTimeBonus - latenessPenalty
 *
 * Blocked and missed visits receive score = 0 (they are not rankable).
 */

import { differenceInMinutes } from 'date-fns';
import type {
  VisitCandidate,
  ClassificationResult,
  SchedulingConfig,
  ScoreResult,
} from './types';

const BASE_WEIGHTS: Record<string, number> = {
  APPT_PROTECTED: 1000,
  APPT_LATE_SOFT: 800,
  WALKIN_FASTTRACK: 650,
  WALKIN_STANDARD: 600,
  MANUAL_OVERRIDE: 0, // Handled via override lifecycle, not base weight
  BLOCKED_PARTS: 0,
  BLOCKED_SKILL: 0,
  MISSED_APPOINTMENT: 0,
};

export function calculateScore(
  visit: VisitCandidate,
  classification: ClassificationResult,
  now: Date,
  config: SchedulingConfig,
): ScoreResult {
  const baseWeight = BASE_WEIGHTS[classification.priorityClass] ?? 0;

  // Blocked and missed visits are not scorable
  if (baseWeight === 0) {
    return {
      score: 0,
      breakdown: {
        baseWeight: 0,
        waitTimeBonus: 0,
        latenessPenalty: 0,
        quickServiceBonus: 0,
        batchingBonus: 0,
      },
    };
  }

  // Wait time bonus: min(waitMinutes, cap) * bonusPerMin
  const waitMinutes = Math.max(0, differenceInMinutes(now, visit.checkedInAt));
  const cappedWait = Math.min(waitMinutes, config.waitTimeBonusCapMin);
  const waitTimeBonus = cappedWait * config.waitTimeBonusPerMin;

  // Lateness penalty: only for APPT_LATE_SOFT with a scheduled time
  let latenessPenalty = 0;
  if (
    classification.priorityClass === 'APPT_LATE_SOFT' &&
    visit.scheduledStartAt
  ) {
    const totalLateMinutes = differenceInMinutes(
      visit.checkedInAt,
      visit.scheduledStartAt,
    );
    const penalizableMinutes = Math.max(
      0,
      totalLateMinutes - config.protectedWindowLateMin,
    );
    latenessPenalty = penalizableMinutes * config.latenessPenaltyPerMin;
  }

  // Phase 2: Quick-service bonus — awarded when visit is short AND classified as WALKIN_FASTTRACK.
  // Currently returns 0 because the priority classifier does not yet assign WALKIN_FASTTRACK.
  const quickServiceBonus =
    classification.priorityClass === 'WALKIN_FASTTRACK' &&
    visit.serviceDurationMinutes <= 30
      ? 50
      : 0;

  // Phase 2: Batching bonus — awarded when compatible services can be grouped.
  // Infrastructure placeholder; returns 0 until batching logic is activated.
  const batchingBonus = 0;

  const score = Math.max(
    0,
    baseWeight + waitTimeBonus - latenessPenalty + quickServiceBonus + batchingBonus,
  );

  return {
    score,
    breakdown: { baseWeight, waitTimeBonus, latenessPenalty, quickServiceBonus, batchingBonus },
  };
}
