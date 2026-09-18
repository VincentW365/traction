import { describe, it, expect } from 'vitest';
import {
  ASSESSMENT_CODE,
  BOOKING_CATEGORIES,
  concernRequired,
  findCategory,
  needsOption,
  resolveServiceCodes,
  schedulingChanged,
} from '../booking-categories';

/**
 * CR-2026-111 §4/§15 — what a customer's choice books.
 *
 * This is the layer where a plain-English card becomes an approved ServiceType
 * code, so it is also the layer where a mistake books the wrong work. Every rule
 * management set is asserted here rather than left to a reviewer's eye over JSX.
 */

describe('every category resolves to approved service codes', () => {
  it('no category is a dead end', () => {
    for (const c of BOOKING_CATEGORIES) {
      if (c.options && c.options.length > 0) {
        for (const o of c.options) {
          expect(resolveServiceCodes(c.key, o.key), `${c.key}/${o.key}`).not.toHaveLength(0);
        }
      } else {
        expect(resolveServiceCodes(c.key, null), c.key).not.toHaveLength(0);
      }
    }
  });

  it('maps the eight approved cards to the approved codes', () => {
    expect(resolveServiceCodes('GENERAL_SERVICING')).toEqual(['GEN-SERV-01']);
    expect(resolveServiceCodes('OIL_CHANGE')).toEqual(['OIL-01']);
    expect(resolveServiceCodes('BATTERY')).toEqual(['BAT-01']);
    expect(resolveServiceCodes('CLEANING')).toEqual(['CLEAN-01']);
    expect(resolveServiceCodes('OTHER')).toEqual([ASSESSMENT_CODE]);
    expect(resolveServiceCodes('BRAKES', 'inspect')).toEqual(['BRK-01']);
    expect(resolveServiceCodes('BRAKES', 'pads')).toEqual(['BRK-02']);
    expect(resolveServiceCodes('TIRES', 'rotation')).toEqual(['TIR-01']);
    expect(resolveServiceCodes('TIRES', 'alignment')).toEqual(['TIR-02']);
    expect(resolveServiceCodes('INSPECTION', 'prepurchase')).toEqual(['INSP-01']);
  });

  /**
   * DISC-01 is superseded by BRK-02. Offering both would let a customer book the
   * retired one, and the two would then compete in reporting for the same work.
   */
  it('never offers the superseded disc code', () => {
    expect(JSON.stringify(BOOKING_CATEGORIES)).not.toContain('DISC-01');
  });

  it('an unknown category or option books nothing rather than guessing', () => {
    expect(resolveServiceCodes('NOT_A_CATEGORY')).toEqual([]);
    expect(resolveServiceCodes('BRAKES', 'not-an-option')).toEqual([]);
    expect(resolveServiceCodes('BRAKES', null)).toEqual([]);
  });
});

/**
 * §15 — a described problem is not a diagnosis.
 *
 * "Something is wrong with the brakes" must book an assessment, never a pad
 * replacement. Booking the repair would decide the job before anyone had looked at
 * the car, and the customer would be quoted for work that may not be needed.
 */
describe('a concern books an assessment, never a repair', () => {
  it.each([
    ['BRAKES', 'concern'],
    ['TIRES', 'concern'],
    ['INSPECTION', 'general'],
  ])('%s/%s resolves to the assessment service', (cat, opt) => {
    expect(resolveServiceCodes(cat, opt)).toEqual([ASSESSMENT_CODE]);
  });

  it('those options carry no repair code of their own', () => {
    const brakes = findCategory('BRAKES')!;
    const concern = brakes.options!.find((o) => o.key === 'concern')!;
    expect(concern.serviceCodes).toEqual([]);
    expect(concern.fallsBackToAssessment).toBe(true);
  });

  it('requires the customer to describe the problem before continuing', () => {
    expect(concernRequired('OTHER')).toBe(true);
    expect(concernRequired('BRAKES', 'concern')).toBe(true);
    expect(concernRequired('TIRES', 'concern')).toBe(true);
    expect(concernRequired('INSPECTION', 'general')).toBe(true);
    // Known work does not need an explanation — they already told us what they want.
    expect(concernRequired('OIL_CHANGE')).toBe(false);
    expect(concernRequired('BRAKES', 'pads')).toBe(false);
    expect(concernRequired('GENERAL_SERVICING')).toBe(false);
  });
});

describe('symptom questions are intake, and belong to their category', () => {
  it('only asks where a symptom is meaningful', () => {
    expect(findCategory('BATTERY')?.symptoms?.length).toBeGreaterThan(0);
    expect(findCategory('BRAKES')?.symptoms?.length).toBeGreaterThan(0);
    expect(findCategory('TIRES')?.symptoms?.length).toBeGreaterThan(0);
    // Nothing to observe about a wash or an oil change.
    expect(findCategory('CLEANING')?.symptoms).toBeUndefined();
    expect(findCategory('OIL_CHANGE')?.symptoms).toBeUndefined();
  });

  it('offers "Not sure" everywhere it asks, so nobody has to invent an answer', () => {
    for (const c of BOOKING_CATEGORIES) {
      if (!c.symptoms) continue;
      expect(c.symptoms.map((s) => s.code), c.key).toContain('NOT_SURE');
    }
  });

  it('symptom codes are unique within a category', () => {
    for (const c of BOOKING_CATEGORIES) {
      if (!c.symptoms) continue;
      const codes = c.symptoms.map((s) => s.code);
      expect(new Set(codes).size, c.key).toBe(codes.length);
    }
  });
});

describe('needsOption', () => {
  it('knows which cards ask a second question', () => {
    expect(needsOption('BRAKES')).toBe(true);
    expect(needsOption('TIRES')).toBe(true);
    expect(needsOption('INSPECTION')).toBe(true);
    expect(needsOption('OIL_CHANGE')).toBe(false);
    expect(needsOption('OTHER')).toBe(false);
  });
});

/**
 * §9 — a chosen time survives an edit that cannot change how long the work takes.
 *
 * This is the whole test of "dependency aware": releasing the time on every edit
 * would be safe but punishing, and releasing it on none would sell a slot too
 * short for the job.
 */
describe('schedulingChanged decides whether a chosen time survives', () => {
  it('a different service releases the time', () => {
    expect(schedulingChanged(['OIL-01'], ['GEN-SERV-01'])).toBe(true);
    expect(schedulingChanged([], ['OIL-01'])).toBe(true);
    expect(schedulingChanged(['OIL-01'], ['OIL-01', 'TIR-01'])).toBe(true);
  });

  it('the same services in any order keep the time', () => {
    expect(schedulingChanged(['OIL-01'], ['OIL-01'])).toBe(false);
    expect(schedulingChanged(['OIL-01', 'TIR-01'], ['TIR-01', 'OIL-01'])).toBe(false);
    expect(schedulingChanged([], [])).toBe(false);
  });

  it('both brake concerns and a general check-over land on the same booking, so the time stands', () => {
    // Re-picking a different "I don't know" option resolves to the same assessment.
    expect(schedulingChanged(resolveServiceCodes('BRAKES', 'concern'), resolveServiceCodes('TIRES', 'concern'))).toBe(false);
  });
});
