import { describe, it, expect, vi } from 'vitest';
import { ClassificationService } from '../classification.service';

/**
 * CR-2026-038 — autoClassify applies a CONFIDENT make/model suggestion automatically;
 * low/no-confidence is left for the small needs-review list; never overwrites a real
 * class; skips placeholder vehicles.
 */
function build(vehicle: unknown, rules: unknown[]) {
  const tx = {
    vehicle: { update: vi.fn(async () => ({})) },
    vehicleClassification: { upsert: vi.fn(async () => ({})) },
  };
  const prisma: any = {
    vehicle: { findUnique: vi.fn(async () => vehicle) },
    vehicleWeightSuggestion: { findMany: vi.fn(async () => rules) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const audit = { log: vi.fn(async () => ({})) };
  const statusHistory = { record: vi.fn(async () => ({})) };
  return { service: new ClassificationService(prisma as any, audit as any, statusHistory as any), prisma, tx, audit };
}

const HIGH_RULE = { makePattern: 'toyota', modelPattern: 'corolla', yearFrom: 2000, yearTo: 2025, suggestedWeightClass: 'LIGHT', suggestedServiceClass: 'SEDAN_CLASS' };

describe('ClassificationService.autoClassify (CR-2026-038)', () => {
  it('auto-applies a confident make/model match', async () => {
    const h = build({ id: 'v1', vehicleCode: 'SCABC', make: 'Toyota', model: 'Corolla', modelYear: 2015, serviceClass: null, weightClass: null }, [HIGH_RULE]);
    const res = await h.service.autoClassify('v1', null);
    expect(res.applied).toBe(true);
    expect(res.serviceClass).toBe('SEDAN_CLASS');
    expect(h.tx.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1' }, data: expect.objectContaining({ serviceClass: 'SEDAN_CLASS' }) }),
    );
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'CLASSIFICATION_AUTO_APPLIED' }));
  });

  it('leaves a no-match vehicle unclassified (needs-review fallback)', async () => {
    const h = build({ id: 'v2', vehicleCode: 'SCXYZ', make: 'Obscure', model: 'Thing', modelYear: 2015, serviceClass: null, weightClass: null }, [HIGH_RULE]);
    const res = await h.service.autoClassify('v2', null);
    expect(res.applied).toBe(false);
    expect(h.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it('does not overwrite an already-set class', async () => {
    const h = build({ id: 'v3', vehicleCode: 'SCPU', make: 'Toyota', model: 'Corolla', modelYear: 2015, serviceClass: 'PICKUP', weightClass: 'HEAVY' }, [HIGH_RULE]);
    const res = await h.service.autoClassify('v3', null);
    expect(res.applied).toBe(false);
  });

  it('skips placeholder vehicles', async () => {
    const h = build({ id: 'v4', vehicleCode: 'HIST-UNRESOLVED-1', make: 'Toyota', model: 'Corolla', modelYear: 2015, serviceClass: null, weightClass: null }, [HIGH_RULE]);
    const res = await h.service.autoClassify('v4', null);
    expect(res.applied).toBe(false);
  });
});
