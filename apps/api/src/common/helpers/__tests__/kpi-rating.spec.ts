import { describe, it, expect } from 'vitest';
import {
  rateCompletionMinutes,
  parseKpiBands,
  DEFAULT_KPI_BANDS,
  DEFAULT_PACKAGE_STANDARD_HOURS,
} from '../kpi-rating';

/**
 * CR-2026-086 — the KPI benchmark supplied by the service manager:
 *
 *   ≤ 2.00 hrs      Excellent
 *   2.01 – 2.50     Meets Target
 *   2.51 – 3.00     Needs Improvement
 *   > 3.00          Below Standard
 *
 * The boundaries are the whole point of the table, so they are pinned exactly.
 */
describe('rateCompletionMinutes', () => {
  it('rates the middle of each band', () => {
    expect(rateCompletionMinutes(60)).toBe('EXCELLENT');           // 1.0h
    expect(rateCompletionMinutes(135)).toBe('MEETS_TARGET');       // 2.25h
    expect(rateCompletionMinutes(165)).toBe('NEEDS_IMPROVEMENT');  // 2.75h
    expect(rateCompletionMinutes(240)).toBe('BELOW_STANDARD');     // 4.0h
  });

  it('treats each upper bound as INCLUSIVE, per the manager table', () => {
    expect(rateCompletionMinutes(120)).toBe('EXCELLENT');          // exactly 2.00h
    expect(rateCompletionMinutes(150)).toBe('MEETS_TARGET');       // exactly 2.50h
    expect(rateCompletionMinutes(180)).toBe('NEEDS_IMPROVEMENT');  // exactly 3.00h
  });

  it('moves to the next band one minute past each bound', () => {
    expect(rateCompletionMinutes(121)).toBe('MEETS_TARGET');
    expect(rateCompletionMinutes(151)).toBe('NEEDS_IMPROVEMENT');
    expect(rateCompletionMinutes(181)).toBe('BELOW_STANDARD');
  });

  it('returns null when there is no time to rate', () => {
    // "No jobs completed" is not a performance result — it must not read as Excellent.
    expect(rateCompletionMinutes(null)).toBeNull();
    expect(rateCompletionMinutes(undefined)).toBeNull();
    expect(rateCompletionMinutes(0)).toBeNull();
    expect(rateCompletionMinutes(-30)).toBeNull();
    expect(rateCompletionMinutes(Number.NaN)).toBeNull();
  });

  it('rates against custom bands when a site retunes them', () => {
    const strict = [
      { maxHours: 1.0, rating: 'EXCELLENT' as const },
      { maxHours: null, rating: 'BELOW_STANDARD' as const },
    ];
    expect(rateCompletionMinutes(60, strict)).toBe('EXCELLENT');
    expect(rateCompletionMinutes(61, strict)).toBe('BELOW_STANDARD');
  });

  it('sorts bands supplied out of order rather than mis-rating', () => {
    const jumbled = [
      { maxHours: null, rating: 'BELOW_STANDARD' as const },
      { maxHours: 2.5, rating: 'MEETS_TARGET' as const },
      { maxHours: 2.0, rating: 'EXCELLENT' as const },
    ];
    expect(rateCompletionMinutes(90, jumbled)).toBe('EXCELLENT');
    expect(rateCompletionMinutes(140, jumbled)).toBe('MEETS_TARGET');
    expect(rateCompletionMinutes(400, jumbled)).toBe('BELOW_STANDARD');
  });
});

describe('parseKpiBands', () => {
  it('accepts the seeded shape unchanged', () => {
    expect(parseKpiBands(DEFAULT_KPI_BANDS)).toEqual(DEFAULT_KPI_BANDS);
  });

  it('falls back to the defaults on anything unusable', () => {
    // Settings is a raw JSON editor, so a typo must degrade to the benchmark
    // rather than throwing or silently rating everyone the same.
    for (const bad of [null, undefined, 'nonsense', 42, {}, []]) {
      expect(parseKpiBands(bad)).toEqual(DEFAULT_KPI_BANDS);
    }
  });

  it('rejects bands with no open-ended final entry', () => {
    // Without a catch-all, a slow job would fall off the end and rate as nothing.
    expect(parseKpiBands([{ maxHours: 2, rating: 'EXCELLENT' }])).toEqual(DEFAULT_KPI_BANDS);
  });

  it('drops individual malformed entries but keeps a usable table', () => {
    const parsed = parseKpiBands([
      { maxHours: 2.0, rating: 'EXCELLENT' },
      { maxHours: -1, rating: 'MEETS_TARGET' },
      { maxHours: 3.0, rating: 'NOT_A_RATING' },
      { maxHours: null, rating: 'BELOW_STANDARD' },
    ]);
    expect(parsed).toEqual([
      { maxHours: 2.0, rating: 'EXCELLENT' },
      { maxHours: null, rating: 'BELOW_STANDARD' },
    ]);
  });
});

describe('package standard times', () => {
  it('matches the benchmark the manager supplied', () => {
    expect(DEFAULT_PACKAGE_STANDARD_HOURS).toEqual({
      GENERAL_SERVICE: 1.5,
      GENERAL_SERVICE_FRONT_BRAKES: 2.0,
      GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS: 2.5,
    });
  });

  it('rates each package at its own standard time', () => {
    // A job run exactly to its package standard should never rate badly.
    expect(rateCompletionMinutes(1.5 * 60)).toBe('EXCELLENT');
    expect(rateCompletionMinutes(2.0 * 60)).toBe('EXCELLENT');
    expect(rateCompletionMinutes(2.5 * 60)).toBe('MEETS_TARGET');
  });
});
