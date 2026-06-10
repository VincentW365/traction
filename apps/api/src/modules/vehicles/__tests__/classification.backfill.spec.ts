import { describe, it, expect } from 'vitest';
import {
  planClassificationBackfill,
  planClassificationRollback,
  type BackfillVehicle,
  type RollbackRow,
} from '../classification.backfill';
import { type VehicleSuggestionRule } from '../../../common/helpers/vehicle-classification';

const RULES: VehicleSuggestionRule[] = [
  { makePattern: 'Toyota', modelPattern: 'Corolla', yearFrom: null, yearTo: null, suggestedWeightClass: 'LIGHT', suggestedServiceClass: 'SEDAN_CLASS' },
  { makePattern: 'Toyota', modelPattern: 'Hilux', yearFrom: null, yearTo: null, suggestedWeightClass: 'STANDARD', suggestedServiceClass: 'PICKUP' },
];

describe('planClassificationBackfill', () => {
  const vehicles: BackfillVehicle[] = [
    { id: 'v1', make: 'Toyota', model: 'Corolla', modelYear: 2019, classificationStatus: null },
    { id: 'v2', make: 'Toyota', model: 'Hilux', modelYear: 2020, classificationStatus: 'PENDING_REVIEW' },
    { id: 'v3', make: 'Tesla', model: 'Model 3', modelYear: 2022, classificationStatus: null },
    { id: 'v4', make: 'Toyota', model: 'Corolla', modelYear: 2019, classificationStatus: 'CONFIRMED' },
  ];

  it('counts suggestions by confidence and reports existing rows', () => {
    const plan = planClassificationBackfill(vehicles, RULES);
    expect(plan.counts.MEDIUM).toBe(3); // v1, v2, v4 match make+model (no year bounds)
    expect(plan.counts.NONE).toBe(1); // v3
    expect(plan.alreadyHasRow).toBe(2); // v2, v4
    expect(plan.alreadyConfirmed).toBe(1); // v4
  });

  it('never plans to overwrite a CONFIRMED row (idempotent + safe)', () => {
    const plan = planClassificationBackfill(vehicles, RULES);
    const v4 = plan.items.find((i) => i.vehicleId === 'v4')!;
    expect(v4.willWrite).toBe(false);
    expect(plan.toWriteCount).toBe(3); // v1, v2, v3 (not v4)
  });

  it('is deterministic — re-running yields the same plan (dry-run == commit decisions)', () => {
    const a = planClassificationBackfill(vehicles, RULES);
    const b = planClassificationBackfill(vehicles, RULES);
    expect(b.toWriteCount).toBe(a.toWriteCount);
    expect(b.items.map((i) => i.willWrite)).toEqual(a.items.map((i) => i.willWrite));
  });

  it('once all rows are CONFIRMED, a re-run writes nothing', () => {
    const allConfirmed = vehicles.map((v) => ({ ...v, classificationStatus: 'CONFIRMED' as const }));
    const plan = planClassificationBackfill(allConfirmed, RULES);
    expect(plan.toWriteCount).toBe(0);
  });
});

describe('planClassificationRollback', () => {
  const rows: RollbackRow[] = [
    { status: 'PENDING_REVIEW', reviewedAt: null }, // deletable
    { status: 'PENDING_REVIEW', reviewedAt: null }, // deletable
    { status: 'CONFIRMED', reviewedAt: new Date('2026-06-10T00:00:00Z') }, // preserved
    { status: 'PENDING_REVIEW', reviewedAt: new Date('2026-06-10T00:00:00Z') }, // reviewed edge → preserved
  ];

  it('only counts unreviewed PENDING rows as deletable', () => {
    const plan = planClassificationRollback(rows);
    expect(plan.deletable).toBe(2);
    expect(plan.preservedConfirmed).toBe(1);
    expect(plan.preservedReviewed).toBe(1);
    expect(plan.total).toBe(4);
  });

  it('never deletes CONFIRMED rows even if reviewedAt is null', () => {
    const plan = planClassificationRollback([
      { status: 'CONFIRMED', reviewedAt: null },
      { status: 'CONFIRMED', reviewedAt: new Date('2026-06-10T00:00:00Z') },
    ]);
    expect(plan.deletable).toBe(0);
    expect(plan.preservedConfirmed).toBe(2);
  });

  it('empty input → nothing deletable', () => {
    expect(planClassificationRollback([])).toEqual({
      total: 0,
      deletable: 0,
      preservedConfirmed: 0,
      preservedReviewed: 0,
    });
  });
});
