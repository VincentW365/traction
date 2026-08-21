import { describe, it, expect } from 'vitest';
import { planConfirmation, summarizeDecisions, type PendingClassRow } from '../classification.bulk-apply';

describe('planConfirmation', () => {
  it('applies the suggested service + weight class when a suggestion exists', () => {
    const row: PendingClassRow = {
      vehicleId: 'v1', suggestedServiceClass: 'SEDAN_CLASS', suggestedWeightClass: 'LIGHT',
      currentServiceClass: null, currentWeightClass: null,
    };
    expect(planConfirmation(row)).toEqual({
      vehicleId: 'v1', serviceClass: 'SEDAN_CLASS', weightClass: 'LIGHT',
      appliedSuggestion: true, becomesMobileJackEligible: true,
    });
  });

  it('keeps the vehicle weight when the suggestion has no weight', () => {
    const row: PendingClassRow = {
      vehicleId: 'v2', suggestedServiceClass: 'SUV_CLASS', suggestedWeightClass: null,
      currentServiceClass: null, currentWeightClass: 'STANDARD',
    };
    const d = planConfirmation(row);
    expect(d.serviceClass).toBe('SUV_CLASS');
    expect(d.weightClass).toBe('STANDARD');
    expect(d.becomesMobileJackEligible).toBe(false); // not sedan
  });

  it('defaults to UNKNOWN_REQUIRES_REVIEW when there is no suggestion (stays mobile-jack blocked)', () => {
    const row: PendingClassRow = {
      vehicleId: 'v3', suggestedServiceClass: null, suggestedWeightClass: null,
      currentServiceClass: null, currentWeightClass: null,
    };
    const d = planConfirmation(row);
    expect(d.serviceClass).toBe('UNKNOWN_REQUIRES_REVIEW');
    expect(d.appliedSuggestion).toBe(false);
    expect(d.becomesMobileJackEligible).toBe(false);
    expect(d.weightClass).toBeNull();
  });

  it('does not count an already-SEDAN vehicle as newly mobile-jack eligible', () => {
    const row: PendingClassRow = {
      vehicleId: 'v4', suggestedServiceClass: 'SEDAN_CLASS', suggestedWeightClass: 'LIGHT',
      currentServiceClass: 'SEDAN_CLASS', currentWeightClass: 'LIGHT',
    };
    expect(planConfirmation(row).becomesMobileJackEligible).toBe(false);
  });
});

describe('summarizeDecisions', () => {
  it('aggregates totals, applied vs defaulted, by target class, newly eligible', () => {
    const rows: PendingClassRow[] = [
      { vehicleId: 'a', suggestedServiceClass: 'SEDAN_CLASS', suggestedWeightClass: 'LIGHT', currentServiceClass: null, currentWeightClass: null },
      { vehicleId: 'b', suggestedServiceClass: 'SUV_CLASS', suggestedWeightClass: 'HEAVY', currentServiceClass: null, currentWeightClass: null },
      { vehicleId: 'c', suggestedServiceClass: null, suggestedWeightClass: null, currentServiceClass: null, currentWeightClass: null },
      { vehicleId: 'd', suggestedServiceClass: null, suggestedWeightClass: null, currentServiceClass: null, currentWeightClass: null },
    ];
    const s = summarizeDecisions(rows.map(planConfirmation));
    expect(s.total).toBe(4);
    expect(s.appliedSuggestion).toBe(2);
    expect(s.defaultedUnknown).toBe(2);
    expect(s.newlyMobileJackEligible).toBe(1);
    expect(s.byTargetServiceClass).toEqual({ SEDAN_CLASS: 1, SUV_CLASS: 1, UNKNOWN_REQUIRES_REVIEW: 2 });
  });
});
