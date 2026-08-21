import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClassificationService } from '../classification.service';

const RULE_ROWS = [
  { makePattern: 'Toyota', modelPattern: 'Corolla', yearFrom: null, yearTo: null, suggestedWeightClass: 'LIGHT', suggestedServiceClass: 'SEDAN_CLASS' },
];

function build() {
  const tx: any = {
    vehicle: { update: vi.fn(async () => ({})) },
    vehicleClassification: { upsert: vi.fn(async () => ({})) },
  };
  const prisma: any = {
    vehicle: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    vehicleClassification: { count: vi.fn(async () => 0) },
    businessRuleConfig: { findFirst: vi.fn(async () => null) },
    vehicleWeightSuggestion: { findMany: vi.fn(async () => RULE_ROWS) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const audit = { log: vi.fn(async () => ({})) };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const service = new ClassificationService(prisma, audit as any, statusHistory as any);
  return { service, prisma, tx, audit, statusHistory };
}

describe('ClassificationService.getQueue', () => {
  it('filters to unclassified + live (non-placeholder) vehicles, orders suggestable-first, returns {items,total}', async () => {
    const h = build();
    h.prisma.vehicle.count.mockResolvedValueOnce(1);
    h.prisma.vehicle.findMany.mockResolvedValueOnce([
      {
        id: 'v1', vehicleCode: 'SC-ABC', plateNumber: 'ABC', make: 'Toyota', model: 'Corolla', modelYear: 2019,
        weightClass: null, serviceClass: null, classification: null,
        customer: { firstName: 'Jane', lastName: 'Doe' },
      },
    ]);

    const out = await h.service.getQueue();

    const args = h.prisma.vehicle.findMany.mock.calls[0][0];
    expect(args.where.serviceClass).toBeNull();
    expect(args.where.vehicleCode).toEqual({ not: { startsWith: 'HIST-UNRESOLVED-' } });
    expect(args.orderBy).toEqual([
      { classification: { confidence: 'asc' } },
      { updatedAt: 'desc' },
    ]);
    expect(h.prisma.vehicle.count).toHaveBeenCalledWith({ where: args.where });
    expect(out.total).toBe(1);
    expect(out.items[0].suggestion.suggestedServiceClass).toBe('SEDAN_CLASS');
    expect(out.items[0].classificationStatus).toBe('PENDING_REVIEW');
  });

  it('applies confidence filter and make/model/plate search, clamps limit, applies offset', async () => {
    const h = build();
    await h.service.getQueue({ confidence: 'MEDIUM' as any, search: 'corolla', limit: 999, offset: 40 });

    const args = h.prisma.vehicle.findMany.mock.calls[0][0];
    expect(args.where.classification).toEqual({ is: { confidence: 'MEDIUM' } });
    expect(args.where.OR).toEqual([
      { make: { contains: 'corolla', mode: 'insensitive' } },
      { model: { contains: 'corolla', mode: 'insensitive' } },
      { plateNumber: { contains: 'corolla', mode: 'insensitive' } },
    ]);
    expect(args.take).toBe(200); // clamped
    expect(args.skip).toBe(40);
  });
});

describe('ClassificationService.getStats', () => {
  it('returns live-only counts, percent classified, mobile-jack eligible, and breakdowns', async () => {
    const h = build();
    // CR-2026-087 — three service classes now (was seven), so the call order is
    // totalLive, unclassified, 3 serviceClasses (SEDAN first), then 4 confidences.
    h.prisma.vehicle.count
      .mockResolvedValueOnce(100) // totalLive
      .mockResolvedValueOnce(60) // unclassified
      .mockResolvedValueOnce(10) // SEDAN_CLASS
      .mockResolvedValueOnce(27) // SUV_CLASS
      .mockResolvedValueOnce(3) // UNKNOWN_REQUIRES_REVIEW
      .mockResolvedValueOnce(0) // HIGH
      .mockResolvedValueOnce(30) // MEDIUM
      .mockResolvedValueOnce(0) // LOW
      .mockResolvedValueOnce(30); // NONE

    const out = await h.service.getStats();

    expect(out.totalLive).toBe(100);
    expect(out.unclassified).toBe(60);
    expect(out.classified).toBe(40);
    expect(out.percentClassified).toBe(40);
    expect(out.mobileJackEligible).toBe(10);
    expect(out.confirmedByClass).toHaveLength(3);
    expect(out.confirmedByClass[0]).toEqual({ serviceClass: 'SEDAN_CLASS', count: 10 });
    expect(out.pendingByConfidence).toEqual([
      { confidence: 'HIGH', count: 0 },
      { confidence: 'MEDIUM', count: 30 },
      { confidence: 'LOW', count: 0 },
      { confidence: 'NONE', count: 30 },
    ]);

    // live-only filtering applied (placeholder excluded) on the totalLive count
    const firstWhere = h.prisma.vehicle.count.mock.calls[0][0].where;
    expect(firstWhere.vehicleCode).toEqual({ not: { startsWith: 'HIST-UNRESOLVED-' } });
    // unclassified count is serviceClass null + live
    const secondWhere = h.prisma.vehicle.count.mock.calls[1][0].where;
    expect(secondWhere.serviceClass).toBeNull();
    expect(secondWhere.vehicleCode).toEqual({ not: { startsWith: 'HIST-UNRESOLVED-' } });
  });

  it('percentClassified is 0 when there are no live vehicles', async () => {
    const h = build();
    h.prisma.vehicle.count.mockResolvedValue(0);
    const out = await h.service.getStats();
    expect(out.percentClassified).toBe(0);
    expect(out.mobileJackEligible).toBe(0);
  });
});

describe('ClassificationService.getProductivity', () => {
  function setup(h: ReturnType<typeof build>) {
    h.prisma.vehicleClassification.count.mockResolvedValueOnce(7); // today confirmed
    h.prisma.vehicle.count.mockResolvedValueOnce(100); // remaining unclassified (live)
    h.prisma.$queryRaw
      .mockResolvedValueOnce([{ day: new Date('2026-06-10T00:00:00Z'), confirmed: 5 }]) // velocity
      .mockResolvedValueOnce([{ reviewerId: 'u1', reviewerName: 'Manager User', confirmed: 5 }]); // byReviewer
  }

  it('defaults daily target to 50 when no BusinessRuleConfig rule exists', async () => {
    const h = build();
    setup(h);
    const out = await h.service.getProductivity();
    expect(out.dailyTarget).toBe(50);
    expect(out.today).toEqual({ confirmed: 7, target: 50, remainingToTarget: 43 });
    expect(out.remainingUnclassified).toBe(100);
    expect(out.velocity).toEqual([{ date: '2026-06-10', confirmed: 5 }]);
    expect(out.byReviewer).toEqual([{ reviewerId: 'u1', reviewerName: 'Manager User', confirmed: 5 }]);
    expect(out.recentAvgPerDay).toBe(5);
    expect(out.projectionDaysAtRecent).toBe(20); // ceil(100/5)
    expect(out.projectionDaysAtTarget).toBe(2); // ceil(100/50)
  });

  it('reads daily target from BusinessRuleConfig (valueJson.target)', async () => {
    const h = build();
    h.prisma.businessRuleConfig.findFirst.mockResolvedValueOnce({ valueJson: { target: 30 } });
    setup(h);
    const out = await h.service.getProductivity();
    expect(out.dailyTarget).toBe(30);
    expect(out.today.remainingToTarget).toBe(23); // 30 - 7
    expect(h.prisma.businessRuleConfig.findFirst.mock.calls[0][0].where).toEqual({
      ruleKey: 'classification_daily_target',
    });
  });

  it('clamps the days window to 1..90', async () => {
    const hi = build(); setup(hi);
    expect((await hi.service.getProductivity({ days: 999 })).days).toBe(90);
    const lo = build(); setup(lo);
    expect((await lo.service.getProductivity({ days: 0 })).days).toBe(1);
  });
});

describe('ClassificationService.confirm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the operational serviceClass + a CONFIRMED audit record + AuditLog + StatusHistory', async () => {
    const h = build();
    h.prisma.vehicle.findUnique.mockResolvedValueOnce({
      id: 'v1', vehicleCode: 'SC-ABC', make: 'Toyota', model: 'Corolla', modelYear: 2019,
      serviceClass: null, weightClass: null,
    });

    const res = await h.service.confirm('v1', 'u1', { serviceClass: 'SEDAN_CLASS', weightClass: 'LIGHT', notes: 'ok' });

    expect(h.tx.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1' }, data: expect.objectContaining({ serviceClass: 'SEDAN_CLASS', weightClass: 'LIGHT' }) }),
    );
    const upsertArg = h.tx.vehicleClassification.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ vehicleId: 'v1' });
    expect(upsertArg.create.status).toBe('CONFIRMED');
    expect(upsertArg.create.confirmedServiceClass).toBe('SEDAN_CLASS');
    expect(upsertArg.create.reviewedByUserId).toBe('u1');
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'VEHICLE_CLASSIFIED',
        entityType: 'Vehicle',
        entityId: 'v1',
        beforeJson: { serviceClass: null, weightClass: null },
        afterJson: { serviceClass: 'SEDAN_CLASS', weightClass: 'LIGHT' },
      }),
    );
    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Vehicle', toStatus: 'SEDAN_CLASS' }),
    );
    expect(res.confirmed.serviceClass).toBe('SEDAN_CLASS');
  });

  it('rejects a historical placeholder vehicle and writes nothing', async () => {
    const h = build();
    h.prisma.vehicle.findUnique.mockResolvedValueOnce({
      id: 'vH', vehicleCode: 'HIST-UNRESOLVED-42', make: null, model: null, modelYear: null,
      serviceClass: null, weightClass: null,
    });

    await expect(h.service.confirm('vH', 'u1', { serviceClass: 'SEDAN_CLASS' })).rejects.toThrow(/placeholder/i);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('throws when the vehicle does not exist', async () => {
    const h = build();
    h.prisma.vehicle.findUnique.mockResolvedValueOnce(null);
    await expect(h.service.confirm('nope', 'u1', { serviceClass: 'SEDAN_CLASS' })).rejects.toThrow(/not found/i);
  });
});

describe('ClassificationService.bulkConfirm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('confirms valid items and collects failures without aborting the batch', async () => {
    const h = build();
    h.prisma.vehicle.findUnique
      .mockResolvedValueOnce({ id: 'v1', vehicleCode: 'SC-1', make: 'Toyota', model: 'Corolla', modelYear: 2019, serviceClass: null, weightClass: null })
      .mockResolvedValueOnce(null); // second item missing

    const out = await h.service.bulkConfirm('u1', [
      { vehicleId: 'v1', serviceClass: 'SEDAN_CLASS' },
      { vehicleId: 'v2', serviceClass: 'SUV_CLASS' },
    ]);

    expect(out.confirmed).toBe(1);
    expect(out.failed).toBe(1);
    expect(h.audit.log).toHaveBeenCalledTimes(1);
  });
});
