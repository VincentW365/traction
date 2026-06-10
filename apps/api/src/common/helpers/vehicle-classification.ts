/**
 * Vehicle classification suggestion engine (CR-2026-008).
 *
 * Pure, I/O-free matcher: given a vehicle's make/model/year and the set of
 * VehicleWeightSuggestion lookup rows, propose an ADVISORY serviceClass +
 * weightClass with a confidence band. The result is never written to
 * Vehicle.serviceClass without explicit staff confirmation — it only seeds the
 * review queue (DMAIC Rule 3 fail-safe is preserved upstream).
 *
 * Unit-testable like common/helpers/mileage-gate.ts and operational-scope.ts.
 *
 * Confidence:
 *  - HIGH   = make + model match AND the rule's year range contains the vehicle year
 *  - MEDIUM = make + model match, but year is not specified by the rule or unknown
 *  - LOW    = only a generic make-level rule (no model pattern) matches
 *  - NONE   = no match (suggestions are null; vehicle still fully reviewable)
 */
import {
  VehicleServiceClass,
  VehicleWeightClass,
  ClassificationConfidence,
  ClassificationSource,
} from '@prisma/client';

export interface VehicleSuggestionRule {
  makePattern: string;
  modelPattern: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  suggestedWeightClass: VehicleWeightClass;
  suggestedServiceClass: VehicleServiceClass | null;
}

export interface VehicleClassInput {
  make?: string | null;
  model?: string | null;
  modelYear?: number | null;
}

export interface ClassificationSuggestion {
  suggestedServiceClass: VehicleServiceClass | null;
  suggestedWeightClass: VehicleWeightClass | null;
  confidence: ClassificationConfidence;
  source: ClassificationSource;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Case-insensitive containment: does `value` contain `pattern`? */
function contains(value: string | null | undefined, pattern: string | null | undefined): boolean {
  const p = norm(pattern);
  if (!p) return false;
  return norm(value).includes(p);
}

type YearFit = 'in' | 'out' | 'unknown' | 'norule';
function yearFit(rule: VehicleSuggestionRule, year: number | null | undefined): YearFit {
  if (rule.yearFrom == null && rule.yearTo == null) return 'norule';
  if (year == null) return 'unknown';
  if (rule.yearFrom != null && year < rule.yearFrom) return 'out';
  if (rule.yearTo != null && year > rule.yearTo) return 'out';
  return 'in';
}

const EMPTY: ClassificationSuggestion = {
  suggestedServiceClass: null,
  suggestedWeightClass: null,
  confidence: ClassificationConfidence.NONE,
  source: ClassificationSource.MAKE_MODEL_LOOKUP,
};

/**
 * Compute the best advisory suggestion for a vehicle from the lookup rules.
 * Deterministic: prefers higher confidence, then earliest matching rule.
 */
export function suggestVehicleClass(
  vehicle: VehicleClassInput,
  rules: VehicleSuggestionRule[],
): ClassificationSuggestion {
  if (!norm(vehicle.make)) return EMPTY;

  const makeMatched = rules.filter((r) => contains(vehicle.make, r.makePattern));
  if (makeMatched.length === 0) return EMPTY;

  // make + model matches (exclude rules whose year range explicitly excludes the vehicle)
  let high: VehicleSuggestionRule | null = null;
  let medium: VehicleSuggestionRule | null = null;
  for (const r of makeMatched) {
    if (!r.modelPattern || !contains(vehicle.model, r.modelPattern)) continue;
    const fit = yearFit(r, vehicle.modelYear);
    if (fit === 'out') continue;
    if (fit === 'in') {
      if (!high) high = r;
    } else {
      // 'norule' (rule has no year bounds) or 'unknown' (vehicle year missing)
      if (!medium) medium = r;
    }
  }

  const chosen = high ?? medium;
  if (chosen) {
    return {
      suggestedServiceClass: chosen.suggestedServiceClass,
      suggestedWeightClass: chosen.suggestedWeightClass,
      confidence: high ? ClassificationConfidence.HIGH : ClassificationConfidence.MEDIUM,
      source: ClassificationSource.MAKE_MODEL_LOOKUP,
    };
  }

  // LOW: a generic make-level rule (no model pattern) whose year does not exclude
  const generic = makeMatched.find((r) => !r.modelPattern && yearFit(r, vehicle.modelYear) !== 'out');
  if (generic) {
    return {
      suggestedServiceClass: generic.suggestedServiceClass,
      suggestedWeightClass: generic.suggestedWeightClass,
      confidence: ClassificationConfidence.LOW,
      source: ClassificationSource.MAKE_MODEL_LOOKUP,
    };
  }

  return EMPTY;
}
