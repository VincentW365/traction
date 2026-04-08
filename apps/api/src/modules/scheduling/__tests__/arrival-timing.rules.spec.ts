/**
 * Arrival Timing Rules — Unit Tests
 *
 * Tests classifyArrival() for all boundary cases per ARR-002 through ARR-005.
 * Uses 'America/Jamaica' (UTC-5, no DST) to eliminate DST edge cases.
 *
 * Delta convention:
 *   negative = arrived BEFORE scheduled (early)
 *   positive = arrived AFTER scheduled (late)
 *
 * Default config:
 *   protectedWindowEarlyMin: 30
 *   protectedWindowLateMin: 15
 *   missedThresholdMin: 30
 *
 * Boundary map:
 *   T-31       → WALKIN_STANDARD   (arrived_early)
 *   T-30       → APPT_PROTECTED    (boundary, inclusive)
 *   T+0        → APPT_PROTECTED    (on time)
 *   T+15       → APPT_PROTECTED    (boundary, inclusive)
 *   T+15:01    → APPT_LATE_SOFT    (just past protected)
 *   T+30       → APPT_LATE_SOFT    (boundary, inclusive — "more than" requires > 30)
 *   T+29:59    → APPT_LATE_SOFT    (29.983 min < 30, still within soft-late)
 *   T+30:01    → MISSED_APPOINTMENT (30.016 min > 30)
 *   T+31       → MISSED_APPOINTMENT
 */

import { describe, it, expect } from 'vitest';
import {
  classifyArrival,
  type ArrivalTimingConfig,
} from '../rules/arrival-timing.rules';

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const SITE_TIMEZONE = 'America/Jamaica'; // UTC-5, no DST

const DEFAULT_CONFIG: ArrivalTimingConfig = {
  protectedWindowEarlyMin: 30,
  protectedWindowLateMin: 15,
  missedThresholdMin: 30,
};

/**
 * Helper: create a scheduled start at 9:00 AM Jamaica time (14:00 UTC).
 * Using a fixed date avoids any DST ambiguity.
 */
const SCHEDULED_UTC = new Date('2026-03-31T14:00:00.000Z'); // 9:00 AM Jamaica

/**
 * Helper: create an arrival time at a given offset from the scheduled start.
 * @param offsetMinutes  Positive = late, negative = early.
 * @param offsetSeconds  Additional seconds offset (default 0).
 */
function arrivalAt(offsetMinutes: number, offsetSeconds = 0): Date {
  const ms =
    SCHEDULED_UTC.getTime() +
    offsetMinutes * 60_000 +
    offsetSeconds * 1_000;
  return new Date(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyArrival', () => {
  // -------------------------------------------------------------------------
  // Protected Window (ARR-002)
  // -------------------------------------------------------------------------
  describe('APPT_PROTECTED — within protected window', () => {
    it('EC-01: exactly T-30 (left boundary) → APPT_PROTECTED', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(-30),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_PROTECTED');
      expect(result.reasonCodes).toContain('appointment_protected');
    });

    it('EC-02: exactly T+15 (right boundary) → APPT_PROTECTED', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(15),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_PROTECTED');
      expect(result.reasonCodes).toContain('appointment_protected');
    });

    it('exactly on time (T+0) → APPT_PROTECTED', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(0),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_PROTECTED');
      expect(result.reasonCodes).toContain('appointment_protected');
    });

    it('T-15 (middle of window) → APPT_PROTECTED', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(-15),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_PROTECTED');
      expect(result.reasonCodes).toContain('appointment_protected');
    });

    it('T+10 (comfortably within) → APPT_PROTECTED', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(10),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_PROTECTED');
      expect(result.reasonCodes).toContain('appointment_protected');
    });
  });

  // -------------------------------------------------------------------------
  // Soft Late (ARR-004)
  // -------------------------------------------------------------------------
  describe('APPT_LATE_SOFT — past protected, within missed threshold', () => {
    it('EC-03: T+15:01 (1 second past protected boundary) → APPT_LATE_SOFT', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(15, 1), // 15 minutes and 1 second late
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_LATE_SOFT');
      expect(result.reasonCodes).toContain('arrived_late_soft');
    });

    it('EC-04: T+30:00 (right boundary of soft-late, exactly at missed threshold) → APPT_LATE_SOFT', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(30),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_LATE_SOFT');
      expect(result.reasonCodes).toContain('arrived_late_soft');
    });

    it('T+29:59 (1 second before the missed threshold minute) → APPT_LATE_SOFT', () => {
      // 29 min 59 sec = 29.983 min, which is <= 30 → still soft-late
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(29, 59),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_LATE_SOFT');
      expect(result.reasonCodes).toContain('arrived_late_soft');
    });

    it('T+30:59 (past missed threshold) → MISSED_APPOINTMENT', () => {
      // 30 min 59 sec = 30.983 min, which is > 30 → missed
      // Note: "more than 30 minutes late" per ARR-005 means any fraction past 30:00.
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(30, 59),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('MISSED_APPOINTMENT');
      expect(result.reasonCodes).toContain('missed_appointment');
    });

    it('T+20 (middle of soft-late window) → APPT_LATE_SOFT', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(20),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_LATE_SOFT');
      expect(result.reasonCodes).toContain('arrived_late_soft');
    });
  });

  // -------------------------------------------------------------------------
  // Missed (ARR-005)
  // -------------------------------------------------------------------------
  describe('MISSED_APPOINTMENT — beyond missed threshold', () => {
    it('EC-05: T+31:00 (1 minute past missed threshold) → MISSED_APPOINTMENT', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(31),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('MISSED_APPOINTMENT');
      expect(result.reasonCodes).toContain('missed_appointment');
    });

    it('T+30:01 (1 second past missed threshold) → MISSED_APPOINTMENT', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(30, 1),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('MISSED_APPOINTMENT');
      expect(result.reasonCodes).toContain('missed_appointment');
    });

    it('T+60 (well past missed) → MISSED_APPOINTMENT', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(60),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('MISSED_APPOINTMENT');
      expect(result.reasonCodes).toContain('missed_appointment');
    });
  });

  // -------------------------------------------------------------------------
  // Too Early — Temporary Walk-In (ARR-003)
  // -------------------------------------------------------------------------
  describe('WALKIN_STANDARD — arrived too early', () => {
    it('T-31 (1 minute before protected window opens) → WALKIN_STANDARD', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(-31),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('WALKIN_STANDARD');
      expect(result.reasonCodes).toContain('arrived_early');
    });

    it('T-30:01 (1 second before protected window) → WALKIN_STANDARD', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(-30, -1), // -30 min minus 1 sec = -30 min -1 sec
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('WALKIN_STANDARD');
      expect(result.reasonCodes).toContain('arrived_early');
    });

    it('T-60 (very early) → WALKIN_STANDARD', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(-60),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('WALKIN_STANDARD');
      expect(result.reasonCodes).toContain('arrived_early');
    });
  });

  // -------------------------------------------------------------------------
  // Configurable Thresholds
  // -------------------------------------------------------------------------
  describe('respects custom configuration', () => {
    const customConfig: ArrivalTimingConfig = {
      protectedWindowEarlyMin: 15,  // tighter early window
      protectedWindowLateMin: 10,   // tighter late window
      missedThresholdMin: 20,       // shorter missed threshold
    };

    it('T-16 with early window of 15 → WALKIN_STANDARD', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(-16),
        SITE_TIMEZONE,
        customConfig,
      );

      expect(result.priorityClass).toBe('WALKIN_STANDARD');
      expect(result.reasonCodes).toContain('arrived_early');
    });

    it('T-15 with early window of 15 → APPT_PROTECTED', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(-15),
        SITE_TIMEZONE,
        customConfig,
      );

      expect(result.priorityClass).toBe('APPT_PROTECTED');
      expect(result.reasonCodes).toContain('appointment_protected');
    });

    it('T+11 with late window of 10 → APPT_LATE_SOFT', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(11),
        SITE_TIMEZONE,
        customConfig,
      );

      expect(result.priorityClass).toBe('APPT_LATE_SOFT');
      expect(result.reasonCodes).toContain('arrived_late_soft');
    });

    it('T+21 with missed threshold of 20 → MISSED_APPOINTMENT', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(21),
        SITE_TIMEZONE,
        customConfig,
      );

      expect(result.priorityClass).toBe('MISSED_APPOINTMENT');
      expect(result.reasonCodes).toContain('missed_appointment');
    });
  });

  // -------------------------------------------------------------------------
  // Timezone correctness
  // -------------------------------------------------------------------------
  describe('timezone handling', () => {
    it('produces same classification regardless of system timezone', () => {
      // 9:00 AM Jamaica = 14:00 UTC
      // Arrival at 9:10 AM Jamaica = 14:10 UTC → T+10 → APPT_PROTECTED
      const scheduled = new Date('2026-03-31T14:00:00.000Z');
      const arrival = new Date('2026-03-31T14:10:00.000Z');

      const result = classifyArrival(
        scheduled,
        arrival,
        'America/Jamaica',
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_PROTECTED');
    });

    it('handles a different timezone correctly (America/New_York with DST)', () => {
      // 2026-03-31 is during EDT (UTC-4) for New York
      // Scheduled 9:00 AM EDT = 13:00 UTC
      // Arrival 9:20 AM EDT = 13:20 UTC → T+20 → APPT_LATE_SOFT
      const scheduled = new Date('2026-03-31T13:00:00.000Z');
      const arrival = new Date('2026-03-31T13:20:00.000Z');

      const result = classifyArrival(
        scheduled,
        arrival,
        'America/New_York',
        DEFAULT_CONFIG,
      );

      expect(result.priorityClass).toBe('APPT_LATE_SOFT');
      expect(result.reasonCodes).toContain('arrived_late_soft');
    });
  });

  // -------------------------------------------------------------------------
  // Return value structure
  // -------------------------------------------------------------------------
  describe('return value structure', () => {
    it('always returns a non-empty reasonCodes array', () => {
      const result = classifyArrival(
        SCHEDULED_UTC,
        arrivalAt(0),
        SITE_TIMEZONE,
        DEFAULT_CONFIG,
      );

      expect(result.reasonCodes).toBeInstanceOf(Array);
      expect(result.reasonCodes.length).toBeGreaterThan(0);
    });

    it('returns exactly one reason code per classification', () => {
      const cases = [
        arrivalAt(-31), // early
        arrivalAt(0),   // protected
        arrivalAt(20),  // late soft
        arrivalAt(60),  // missed
      ];

      for (const arrival of cases) {
        const result = classifyArrival(
          SCHEDULED_UTC,
          arrival,
          SITE_TIMEZONE,
          DEFAULT_CONFIG,
        );
        expect(result.reasonCodes).toHaveLength(1);
      }
    });
  });
});
