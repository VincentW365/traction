/**
 * Bulk accept-suggestion planning (owner-authorized clear of the classification
 * review queue). Pure, I/O-free, unit-testable (mirrors classification.backfill.ts).
 *
 * Decision per PENDING_REVIEW row:
 *  - has a suggested service class  -> CONFIRM with the suggested class
 *    (+ suggested weight, else keep the vehicle's current weight),
 *  - no suggestion (confidence NONE) -> CONFIRM as UNKNOWN_REQUIRES_REVIEW
 *    (clears the queue but stays mobile-jack BLOCKED — Rule 3 preserved).
 *
 * Never decides for placeholder/test vehicles — the caller filters those out.
 */
import { VehicleServiceClass, VehicleWeightClass } from '@prisma/client';

export interface PendingClassRow {
  vehicleId: string;
  suggestedServiceClass: VehicleServiceClass | null;
  suggestedWeightClass: VehicleWeightClass | null;
  currentServiceClass: VehicleServiceClass | null;
  currentWeightClass: VehicleWeightClass | null;
}

export interface ConfirmationDecision {
  vehicleId: string;
  serviceClass: VehicleServiceClass;
  weightClass: VehicleWeightClass | null;
  appliedSuggestion: boolean; // false = defaulted to UNKNOWN_REQUIRES_REVIEW
  becomesMobileJackEligible: boolean; // newly SEDAN_CLASS where it wasn't before
}

export function planConfirmation(row: PendingClassRow): ConfirmationDecision {
  const serviceClass = row.suggestedServiceClass ?? VehicleServiceClass.UNKNOWN_REQUIRES_REVIEW;
  const appliedSuggestion = row.suggestedServiceClass != null;
  const weightClass = appliedSuggestion ? (row.suggestedWeightClass ?? row.currentWeightClass) : row.currentWeightClass;
  const becomesMobileJackEligible =
    serviceClass === VehicleServiceClass.SEDAN_CLASS && row.currentServiceClass !== VehicleServiceClass.SEDAN_CLASS;
  return { vehicleId: row.vehicleId, serviceClass, weightClass, appliedSuggestion, becomesMobileJackEligible };
}

export interface ConfirmationSummary {
  total: number;
  appliedSuggestion: number;
  defaultedUnknown: number;
  byTargetServiceClass: Record<string, number>;
  newlyMobileJackEligible: number;
}

export function summarizeDecisions(decisions: ConfirmationDecision[]): ConfirmationSummary {
  const byTargetServiceClass: Record<string, number> = {};
  let appliedSuggestion = 0;
  let newlyMobileJackEligible = 0;
  for (const d of decisions) {
    byTargetServiceClass[d.serviceClass] = (byTargetServiceClass[d.serviceClass] ?? 0) + 1;
    if (d.appliedSuggestion) appliedSuggestion += 1;
    if (d.becomesMobileJackEligible) newlyMobileJackEligible += 1;
  }
  return {
    total: decisions.length,
    appliedSuggestion,
    defaultedUnknown: decisions.length - appliedSuggestion,
    byTargetServiceClass,
    newlyMobileJackEligible,
  };
}
