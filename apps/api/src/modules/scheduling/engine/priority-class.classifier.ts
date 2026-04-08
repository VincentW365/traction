/**
 * Stage 3 — Priority Class Classifier
 *
 * Assigns a QueuePriorityClass to each visit candidate based on:
 *   - eligibility result (blocked visits get their blocked class)
 *   - manager override status
 *   - source type (APPOINTMENT vs WALKIN)
 *   - arrival timing relative to scheduled start
 *
 * Classification precedence (highest to lowest):
 *   1. Ineligible → blocked class from eligibility evaluator
 *   2. Manager override active → MANUAL_OVERRIDE
 *   3. Appointment → classifyArrival() determines APPT_PROTECTED,
 *      APPT_LATE_SOFT, WALKIN_STANDARD (early), or MISSED_APPOINTMENT
 *   4. Walk-in → WALKIN_STANDARD
 *      (WALKIN_FASTTRACK is disabled in Phase 1 per spec)
 *
 * This is a pure function with NO side effects, NO database access,
 * NO NestJS decorators.
 */

import type {
  VisitCandidate,
  EligibilityResult,
  ClassificationResult,
  SchedulingConfig,
} from './types';
import { classifyArrival } from '../rules/arrival-timing.rules';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Classify a visit candidate into a priority class.
 *
 * @param visit       The visit candidate (already passed Stage 1).
 * @param eligibility The result of Stage 2 eligibility evaluation.
 * @param now         Current UTC timestamp (injected for testability).
 * @param config      Scheduling configuration with thresholds and timezone.
 * @returns           Classification result with priority class and reason codes.
 */
export function classifyVisit(
  visit: VisitCandidate,
  eligibility: EligibilityResult,
  now: Date,
  config: SchedulingConfig,
): ClassificationResult {
  // --- Precedence 1: Ineligible visits get their blocked class ---
  if (!eligibility.eligible) {
    const blockedClass = eligibility.blockedClass ?? 'BLOCKED_SKILL';
    const reasonCode =
      blockedClass === 'BLOCKED_PARTS' ? 'blocked_parts' : 'blocked_skill';

    return {
      priorityClass: blockedClass,
      reasonCodes: [reasonCode],
    };
  }

  // --- Precedence 2: Manager override ---
  if (visit.overrideActive) {
    return {
      priorityClass: 'MANUAL_OVERRIDE',
      reasonCodes: ['manager_override'],
    };
  }

  // --- Precedence 3: Appointment with scheduled time ---
  if (visit.sourceType === 'APPOINTMENT' && visit.scheduledStartAt !== null) {
    const arrivalResult = classifyArrival(
      visit.scheduledStartAt,
      visit.checkedInAt,
      config.siteTimezone,
      {
        protectedWindowEarlyMin: config.protectedWindowEarlyMin,
        protectedWindowLateMin: config.protectedWindowLateMin,
        missedThresholdMin: config.missedThresholdMin,
      },
    );

    return {
      priorityClass: arrivalResult.priorityClass,
      reasonCodes: arrivalResult.reasonCodes,
    };
  }

  // --- Precedence 4: Walk-in (or appointment without scheduled time) ---
  // WALKIN_FASTTRACK is disabled in Phase 1 per Scheduling Engine Spec §8.
  return {
    priorityClass: 'WALKIN_STANDARD',
    reasonCodes: ['walkin_standard'],
  };
}
