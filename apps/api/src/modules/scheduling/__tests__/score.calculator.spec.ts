import { describe, it, expect } from 'vitest';
import { calculateScore } from '../engine/score.calculator';
import type {
  VisitCandidate,
  ClassificationResult,
  SchedulingConfig,
} from '../engine/types';

const defaultConfig: SchedulingConfig = {
  protectedWindowEarlyMin: 30,
  protectedWindowLateMin: 15,
  missedThresholdMin: 30,
  latenessPenaltyPerMin: 3,
  waitTimeBonusPerMin: 2,
  waitTimeBonusCapMin: 120,
  siteTimezone: 'America/Jamaica',
};

function makeVisit(overrides: Partial<VisitCandidate> = {}): VisitCandidate {
  return {
    serviceVisitId: 'v1',
    appointmentId: 'a1',
    sourceType: 'APPOINTMENT',
    scheduledStartAt: new Date('2026-04-01T14:00:00Z'),
    checkedInAt: new Date('2026-04-01T14:00:00Z'),
    status: 'CHECKED_IN',
    serviceDurationMinutes: 30,
    requiredSkillCodes: ['LUBE'],
    requiredBayTypes: ['LUBE'],
    queueTicketId: 't1',
    checkinSequence: 1,
    overrideActive: false,
    overridePriorityMode: null,
    overrideRankPosition: null,
    ...overrides,
  };
}

describe('calculateScore', () => {
  it('APPT_PROTECTED gets base weight 1000 + wait bonus', () => {
    const now = new Date('2026-04-01T14:10:00Z'); // 10 min after check-in
    const visit = makeVisit({ checkedInAt: new Date('2026-04-01T14:00:00Z') });
    const classification: ClassificationResult = {
      priorityClass: 'APPT_PROTECTED',
      reasonCodes: ['appointment_protected'],
    };

    const result = calculateScore(visit, classification, now, defaultConfig);

    expect(result.breakdown.baseWeight).toBe(1000);
    expect(result.breakdown.waitTimeBonus).toBe(10 * 2); // 10 min * 2
    expect(result.breakdown.latenessPenalty).toBe(0);
    expect(result.score).toBe(1020);
  });

  it('WALKIN_STANDARD gets base weight 600 + wait bonus', () => {
    const now = new Date('2026-04-01T15:30:00Z'); // 90 min wait
    const visit = makeVisit({
      sourceType: 'WALKIN',
      scheduledStartAt: null,
      appointmentId: null,
      checkedInAt: new Date('2026-04-01T14:00:00Z'),
    });
    const classification: ClassificationResult = {
      priorityClass: 'WALKIN_STANDARD',
      reasonCodes: ['walkin_standard'],
    };

    const result = calculateScore(visit, classification, now, defaultConfig);

    expect(result.breakdown.baseWeight).toBe(600);
    expect(result.breakdown.waitTimeBonus).toBe(90 * 2); // 180
    expect(result.score).toBe(780);
  });

  it('APPT_LATE_SOFT gets base 800 - lateness penalty', () => {
    // Checked in 22 min late. Penalty = (22-15) * 3 = 21
    const visit = makeVisit({
      scheduledStartAt: new Date('2026-04-01T14:00:00Z'),
      checkedInAt: new Date('2026-04-01T14:22:00Z'),
    });
    const now = new Date('2026-04-01T14:22:00Z'); // just checked in
    const classification: ClassificationResult = {
      priorityClass: 'APPT_LATE_SOFT',
      reasonCodes: ['arrived_late_soft'],
    };

    const result = calculateScore(visit, classification, now, defaultConfig);

    expect(result.breakdown.baseWeight).toBe(800);
    expect(result.breakdown.latenessPenalty).toBe(21); // (22-15)*3
    expect(result.breakdown.waitTimeBonus).toBe(0); // 0 min wait
    expect(result.score).toBe(779); // 800 + 0 - 21
  });

  it('BLOCKED_PARTS gets score 0', () => {
    const visit = makeVisit();
    const classification: ClassificationResult = {
      priorityClass: 'BLOCKED_PARTS',
      reasonCodes: ['blocked_parts'],
    };

    const result = calculateScore(visit, classification, new Date(), defaultConfig);

    expect(result.score).toBe(0);
  });

  it('MISSED_APPOINTMENT gets score 0', () => {
    const visit = makeVisit();
    const classification: ClassificationResult = {
      priorityClass: 'MISSED_APPOINTMENT',
      reasonCodes: ['missed_appointment'],
    };

    const result = calculateScore(visit, classification, new Date(), defaultConfig);

    expect(result.score).toBe(0);
  });

  it('wait time bonus caps at configured maximum', () => {
    // 200 min wait but cap is 120
    const now = new Date('2026-04-01T17:20:00Z');
    const visit = makeVisit({
      checkedInAt: new Date('2026-04-01T14:00:00Z'),
    });
    const classification: ClassificationResult = {
      priorityClass: 'WALKIN_STANDARD',
      reasonCodes: ['walkin_standard'],
    };

    const result = calculateScore(visit, classification, now, defaultConfig);

    expect(result.breakdown.waitTimeBonus).toBe(120 * 2); // capped at 240
    expect(result.score).toBe(600 + 240);
  });

  it('score never goes below 0', () => {
    // Very late: 30 min late, penalty = (30-15)*3 = 45
    // But wait time = 0, so 800 + 0 - 45 = 755 (still positive in this case)
    // Let's test with extreme penalty
    const visit = makeVisit({
      scheduledStartAt: new Date('2026-04-01T14:00:00Z'),
      checkedInAt: new Date('2026-04-01T14:29:00Z'),
    });
    const now = new Date('2026-04-01T14:29:00Z');
    const classification: ClassificationResult = {
      priorityClass: 'APPT_LATE_SOFT',
      reasonCodes: ['arrived_late_soft'],
    };

    const config = { ...defaultConfig, latenessPenaltyPerMin: 100 };
    const result = calculateScore(visit, classification, now, config);

    // (29-15)*100 = 1400 penalty. 800 - 1400 = -600, clamped to 0
    expect(result.score).toBe(0);
  });
});
