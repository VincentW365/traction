/**
 * Arrival Timing Rules — Pure Function
 *
 * Implements business rules ARR-002 through ARR-005:
 *   ARR-002: Protected window is T-30 to T+15 (configurable).
 *   ARR-003: Earlier than T-30 → temporary walk-in until window opens.
 *   ARR-004: T+16 to T+30 late → APPT_LATE_SOFT.
 *   ARR-005: Beyond T+30 late → MISSED_APPOINTMENT.
 *
 * All timestamp comparisons are performed in site-local time per the
 * BSOP timezone policy: timestamps stored as UTC, business rule evaluation
 * converts to site-local using date-fns-tz.
 *
 * This module has NO side effects, NO database access, NO NestJS decorators.
 */

import { toZonedTime } from 'date-fns-tz';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArrivalTimingConfig {
  /** Minutes before scheduled start that still count as "on time". */
  protectedWindowEarlyMin: number;
  /** Minutes after scheduled start that still count as protected. */
  protectedWindowLateMin: number;
  /** Minutes after scheduled start beyond which the appointment is missed. */
  missedThresholdMin: number;
}

export interface ArrivalClassification {
  priorityClass: string;
  reasonCodes: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Classify an appointment arrival based on the delta between the scheduled
 * start time and the actual arrival (check-in) time.
 *
 * Both timestamps are converted to site-local time before computing the
 * delta. The delta is computed as a precise floating-point value in minutes
 * (millisecond resolution / 60000) to ensure correct boundary behavior.
 *
 * Delta semantics:
 *   negative → arrival BEFORE scheduled start (early)
 *   zero     → exactly on time
 *   positive → arrival AFTER scheduled start (late)
 *
 * Classification rules (all boundaries inclusive on the side noted):
 *   delta >= -config.protectedWindowEarlyMin AND delta <= config.protectedWindowLateMin
 *     → APPT_PROTECTED, reason: 'appointment_protected'
 *   delta < -config.protectedWindowEarlyMin
 *     → WALKIN_STANDARD, reason: 'arrived_early'
 *   delta > config.protectedWindowLateMin AND delta <= config.missedThresholdMin
 *     → APPT_LATE_SOFT, reason: 'arrived_late_soft'
 *   delta > config.missedThresholdMin
 *     → MISSED_APPOINTMENT, reason: 'missed_appointment'
 *
 * @param scheduledStartUtc  The appointment's scheduled start in UTC.
 * @param arrivalUtc         The actual check-in time in UTC.
 * @param siteTimezone       IANA timezone identifier for the site.
 * @param config             Configurable threshold values.
 * @returns Classification with priority class and reason codes.
 */
export function classifyArrival(
  scheduledStartUtc: Date,
  arrivalUtc: Date,
  siteTimezone: string,
  config: ArrivalTimingConfig,
): ArrivalClassification {
  // Convert both timestamps to site-local representations.
  // toZonedTime returns a Date whose UTC fields represent the local wall-clock
  // values in the target timezone, allowing arithmetic comparison.
  const scheduledLocal = toZonedTime(scheduledStartUtc, siteTimezone);
  const arrivalLocal = toZonedTime(arrivalUtc, siteTimezone);

  // Compute precise delta in minutes (positive = arrival after scheduled).
  // Using millisecond arithmetic avoids the truncation behavior of
  // date-fns differenceInMinutes, which rounds toward zero and would
  // cause incorrect classification at exact boundaries like T+15:01.
  const deltaMs = arrivalLocal.getTime() - scheduledLocal.getTime();
  const deltaMinutes = deltaMs / 60_000;

  // --- Classification logic (order matters for boundary correctness) ---

  // Within the protected window: T-early to T+late (inclusive on both ends).
  if (
    deltaMinutes >= -config.protectedWindowEarlyMin &&
    deltaMinutes <= config.protectedWindowLateMin
  ) {
    return {
      priorityClass: 'APPT_PROTECTED',
      reasonCodes: ['appointment_protected'],
    };
  }

  // Arrived too early — before the protected window opens.
  if (deltaMinutes < -config.protectedWindowEarlyMin) {
    return {
      priorityClass: 'WALKIN_STANDARD',
      reasonCodes: ['arrived_early'],
    };
  }

  // Late but within the soft-late range: past protected, up to missed threshold.
  if (deltaMinutes <= config.missedThresholdMin) {
    return {
      priorityClass: 'APPT_LATE_SOFT',
      reasonCodes: ['arrived_late_soft'],
    };
  }

  // Beyond the missed threshold.
  return {
    priorityClass: 'MISSED_APPOINTMENT',
    reasonCodes: ['missed_appointment'],
  };
}
