/**
 * Pure planning logic for the CR-2026-008 classification backfill.
 *
 * Separated from the CLI script so it is unit-testable and so dry-run and commit
 * use the EXACT same decisions. Computes advisory suggestions and decides which
 * vehicles get a (re)seeded PENDING_REVIEW row — it NEVER decides to write
 * Vehicle.serviceClass, and it NEVER overwrites a CONFIRMED classification
 * (that is what makes re-runs idempotent and safe).
 */
import {
  suggestVehicleClass,
  type VehicleSuggestionRule,
  type ClassificationSuggestion,
} from '../../common/helpers/vehicle-classification';

export type BackfillClassificationStatus = 'PENDING_REVIEW' | 'CONFIRMED' | null;

export interface BackfillVehicle {
  id: string;
  make?: string | null;
  model?: string | null;
  modelYear?: number | null;
  classificationStatus: BackfillClassificationStatus;
}

export interface BackfillPlanItem {
  vehicleId: string;
  suggestion: ClassificationSuggestion;
  willWrite: boolean; // false when already CONFIRMED (left untouched)
}

export interface BackfillPlan {
  counts: { HIGH: number; MEDIUM: number; LOW: number; NONE: number };
  alreadyHasRow: number;
  alreadyConfirmed: number;
  toWriteCount: number;
  items: BackfillPlanItem[];
}

/** A minimal classification row shape for rollback planning. */
export interface RollbackRow {
  status: 'PENDING_REVIEW' | 'CONFIRMED';
  reviewedAt: Date | null;
}

export interface RollbackPlan {
  total: number;
  deletable: number; // PENDING_REVIEW + never reviewed (unreviewed advisory rows)
  preservedConfirmed: number; // CONFIRMED — never deleted
  preservedReviewed: number; // PENDING but reviewedAt set (edge) — never deleted
}

/**
 * Decide which classification rows the rollback may delete: ONLY unreviewed
 * advisory rows (status PENDING_REVIEW AND reviewedAt IS NULL). Everything that
 * was confirmed or touched by a reviewer is preserved. Pure + testable; the CLI
 * uses the SAME predicate for both the report and the deleteMany filter.
 */
export function planClassificationRollback(rows: RollbackRow[]): RollbackPlan {
  let deletable = 0;
  let preservedConfirmed = 0;
  let preservedReviewed = 0;
  for (const r of rows) {
    if (r.status === 'PENDING_REVIEW' && r.reviewedAt == null) deletable++;
    else if (r.status === 'CONFIRMED') preservedConfirmed++;
    else preservedReviewed++;
  }
  return { total: rows.length, deletable, preservedConfirmed, preservedReviewed };
}

export function planClassificationBackfill(
  vehicles: BackfillVehicle[],
  rules: VehicleSuggestionRule[],
): BackfillPlan {
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
  let alreadyHasRow = 0;
  let alreadyConfirmed = 0;

  const items: BackfillPlanItem[] = vehicles.map((v) => {
    const suggestion = suggestVehicleClass(
      { make: v.make, model: v.model, modelYear: v.modelYear },
      rules,
    );
    counts[suggestion.confidence]++;
    if (v.classificationStatus) {
      alreadyHasRow++;
      if (v.classificationStatus === 'CONFIRMED') alreadyConfirmed++;
    }
    // Never overwrite a staff-confirmed classification.
    const willWrite = v.classificationStatus !== 'CONFIRMED';
    return { vehicleId: v.id, suggestion, willWrite };
  });

  return {
    counts,
    alreadyHasRow,
    alreadyConfirmed,
    toWriteCount: items.filter((i) => i.willWrite).length,
    items,
  };
}
