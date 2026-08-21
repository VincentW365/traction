import { describe, it, expect } from 'vitest';
import {
  suggestVehicleClass,
  type VehicleSuggestionRule,
} from '../vehicle-classification';

const RULES: VehicleSuggestionRule[] = [
  { makePattern: 'Toyota', modelPattern: 'Corolla', yearFrom: null, yearTo: null, suggestedWeightClass: 'LIGHT', suggestedServiceClass: 'SEDAN_CLASS' },
  { makePattern: 'Toyota', modelPattern: 'Hilux', yearFrom: 2015, yearTo: 2024, suggestedWeightClass: 'STANDARD', suggestedServiceClass: 'SUV_CLASS' },
  { makePattern: 'Toyota', modelPattern: 'Land Cruiser', yearFrom: null, yearTo: null, suggestedWeightClass: 'HEAVY', suggestedServiceClass: 'SUV_CLASS' },
  // generic make-level fallback rule (no model)
  { makePattern: 'Suzuki', modelPattern: null, yearFrom: null, yearTo: null, suggestedWeightClass: 'LIGHT', suggestedServiceClass: 'SEDAN_CLASS' },
];

describe('suggestVehicleClass', () => {
  it('HIGH: make + model + year within rule range', () => {
    const r = suggestVehicleClass({ make: 'Toyota', model: 'Hilux', modelYear: 2020 }, RULES);
    expect(r).toEqual({ suggestedServiceClass: 'SUV_CLASS', suggestedWeightClass: 'STANDARD', confidence: 'HIGH', source: 'MAKE_MODEL_LOOKUP' });
  });

  it('MEDIUM: make + model match, rule has no year bounds', () => {
    const r = suggestVehicleClass({ make: 'Toyota', model: 'Corolla', modelYear: 2019 }, RULES);
    expect(r.confidence).toBe('MEDIUM');
    expect(r.suggestedServiceClass).toBe('SEDAN_CLASS');
  });

  it('MEDIUM: make + model match but vehicle year unknown for a year-bounded rule', () => {
    const r = suggestVehicleClass({ make: 'Toyota', model: 'Hilux', modelYear: null }, RULES);
    expect(r.confidence).toBe('MEDIUM');
    expect(r.suggestedServiceClass).toBe('SUV_CLASS');
  });

  it('year OUT of range excludes the rule → NONE when no other match', () => {
    const r = suggestVehicleClass({ make: 'Toyota', model: 'Hilux', modelYear: 2005 }, RULES);
    expect(r.confidence).toBe('NONE');
    expect(r.suggestedServiceClass).toBeNull();
  });

  it('LOW: only a generic make-level rule matches', () => {
    const r = suggestVehicleClass({ make: 'Suzuki', model: 'Alto', modelYear: 2018 }, RULES);
    expect(r.confidence).toBe('LOW');
    expect(r.suggestedServiceClass).toBe('SEDAN_CLASS');
  });

  it('NONE: no make match', () => {
    const r = suggestVehicleClass({ make: 'Tesla', model: 'Model 3', modelYear: 2022 }, RULES);
    expect(r).toEqual({ suggestedServiceClass: null, suggestedWeightClass: null, confidence: 'NONE', source: 'MAKE_MODEL_LOOKUP' });
  });

  it('NONE: missing make', () => {
    expect(suggestVehicleClass({ make: null, model: 'Corolla' }, RULES).confidence).toBe('NONE');
  });

  it('case-insensitive matching', () => {
    const r = suggestVehicleClass({ make: 'TOYOTA', model: 'corolla' }, RULES);
    expect(r.suggestedServiceClass).toBe('SEDAN_CLASS');
  });
});
