import { describe, it, expect, vi } from 'vitest';
import { InspectionsService } from '../inspections.service';

/**
 * CR-2026-034 (C-2) — create-from-template snapshot, DRAFT-only edits, race-safe
 * complete/cancel transitions, add-recommendation, cross-site guard.
 */
function build(over: { inspection?: any; visit?: any; template?: any; updateManyCount?: number } = {}) {
  // Use `in` checks (not ??) so an explicit `null` override reaches the mock.
  const inspection = 'inspection' in over ? over.inspection : {
    id: 'insp1', siteId: 'site1', status: 'DRAFT',
    items: [], wheelMeasurements: [], recommendations: [], signatures: [], customer: null, vehicle: null, serviceVisit: null,
  };
  const visit = 'visit' in over ? over.visit : { id: 'v1', siteId: 'site1', vehicleId: 'veh1', customerId: 'c1' };
  const template = 'template' in over ? over.template : {
    id: 't1', version: 1,
    items: [
      { category: 'Interior / Exterior', label: 'L1', orderIndex: 0 },
      { category: 'Interior / Exterior', label: 'L2', orderIndex: 1 },
    ],
  };
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ next_val: 1 }]),
    vehicleInspection: {
      create: vi.fn(async (a: any) => ({ id: 'insp1', siteId: visit.siteId, ...a.data })),
      update: vi.fn(async (a: any) => ({ ...inspection, ...a.data })),
    },
    inspectionItem: { createMany: vi.fn(async () => ({ count: template.items.length })), updateMany: vi.fn(async () => ({ count: 1 })) },
    inspectionWheelMeasurement: { createMany: vi.fn(async () => ({ count: 4 })), updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma: any = {
    serviceVisit: { findUnique: vi.fn(async () => visit) },
    inspectionTemplate: { findFirst: vi.fn(async () => template) },
    vehicleInspection: {
      findUnique: vi.fn(async () => inspection),
      updateMany: vi.fn(async () => ({ count: over.updateManyCount ?? 1 })),
      update: vi.fn(async (a: any) => ({ ...inspection, ...a.data })),
    },
    inspectionItem: { findFirst: vi.fn(async () => ({ id: 'item1' })) },
    inspectionRecommendation: { create: vi.fn(async (a: any) => ({ id: 'rec1', ...a.data })) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const audit = { log: vi.fn(async () => ({})) };
  const statusHistory = { record: vi.fn(async () => ({})), findByEntity: vi.fn(async () => []) };
  const serviceOrders = { create: vi.fn(async () => ({ id: 'so1', items: [{ id: 'soi1' }] })) };
  const service = new InspectionsService(prisma as any, audit as any, statusHistory as any, serviceOrders as any);
  return { service, prisma, tx, audit, statusHistory, serviceOrders };
}

const MGR = { sub: 'm1', siteId: 'site1', role: 'MANAGER' };

describe('InspectionsService.create (CR-2026-034 C-2)', () => {
  it('snapshots template items + 4 wheels, generates INS-000001, records DRAFT history + audit', async () => {
    const h = build();
    await h.service.create({ serviceVisitId: 'v1' } as any, MGR);
    const created = h.tx.vehicleInspection.create.mock.calls[0][0].data;
    expect(created.inspectionNumber).toBe('INS-000001');
    expect(created.status).toBe('DRAFT');
    expect(created.templateVersion).toBe(1);
    expect(created.vehicleId).toBe('veh1');
    // snapshot: 2 template items copied
    expect(h.tx.inspectionItem.createMany.mock.calls[0][0].data).toHaveLength(2);
    // 4 wheel rows
    const wheels = h.tx.inspectionWheelMeasurement.createMany.mock.calls[0][0].data;
    expect(wheels.map((w: any) => w.position).sort()).toEqual(['LEFT_FRONT', 'LEFT_REAR', 'RIGHT_FRONT', 'RIGHT_REAR']);
    expect(h.statusHistory.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'VehicleInspection', fromStatus: null, toStatus: 'DRAFT' }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INSPECTION_CREATED' }));
  });

  it('rejects creating for another site (non-admin)', async () => {
    const h = build({ visit: { id: 'v1', siteId: 'siteB', vehicleId: 'veh1', customerId: 'c1' } });
    await expect(h.service.create({ serviceVisitId: 'v1' } as any, MGR)).rejects.toThrow(/another site/);
  });

  it('rejects when no active template exists', async () => {
    const h = build({ template: null });
    await expect(h.service.create({ serviceVisitId: 'v1' } as any, MGR)).rejects.toThrow(/Vehicle Inspection is not set up for this site/);
  });

  it('rejects when the visit is missing', async () => {
    const h = build();
    h.prisma.serviceVisit.findUnique.mockResolvedValueOnce(null);
    await expect(h.service.create({ serviceVisitId: 'v1' } as any, MGR)).rejects.toThrow(/not found/);
  });
});

describe('InspectionsService edits + transitions (CR-2026-034 C-2)', () => {
  it('update is blocked unless DRAFT', async () => {
    const h = build({ inspection: { id: 'insp1', siteId: 'site1', status: 'COMPLETED' } });
    await expect(h.service.update('insp1', { comments: 'x' } as any, MGR)).rejects.toThrow(/DRAFT/);
  });

  it('update writes scoped item + wheel updates while DRAFT', async () => {
    const h = build();
    await h.service.update('insp1', { comments: 'looks good', items: [{ itemId: 'item1', result: 'IMMEDIATE' }], wheels: [{ position: 'LEFT_FRONT', tireTread32nds: 6 }] } as any, MGR);
    expect(h.tx.inspectionItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item1', inspectionId: 'insp1' } }));
    expect(h.tx.inspectionWheelMeasurement.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { inspectionId: 'insp1', position: 'LEFT_FRONT' } }));
  });

  it('complete transitions DRAFT→COMPLETED via conditional updateMany (+history+audit)', async () => {
    const h = build();
    await h.service.complete('insp1', MGR);
    expect(h.prisma.vehicleInspection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'insp1', status: 'DRAFT' } }));
    expect(h.statusHistory.record).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'COMPLETED' }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INSPECTION_COMPLETED' }));
  });

  it('complete throws when not DRAFT (updateMany count 0)', async () => {
    const h = build({ updateManyCount: 0 });
    await expect(h.service.complete('insp1', MGR)).rejects.toThrow(/not DRAFT/);
  });

  it('cancel transitions DRAFT/COMPLETED→CANCELLED', async () => {
    const h = build();
    await h.service.cancel('insp1', MGR);
    expect(h.prisma.vehicleInspection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'insp1', status: { in: ['DRAFT', 'COMPLETED'] } } }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INSPECTION_CANCELLED' }));
  });

  it('addRecommendation only while DRAFT; creates the recommendation', async () => {
    const h = build();
    const rec = await h.service.addRecommendation('insp1', { severity: 'IMMEDIATE', description: 'Brake pads worn' } as any, MGR);
    expect(rec.id).toBe('rec1');
    const blocked = build({ inspection: { id: 'insp1', siteId: 'site1', status: 'SIGNED_OFF' } });
    await expect(blocked.service.addRecommendation('insp1', { severity: 'FUTURE', description: 'x' } as any, MGR)).rejects.toThrow(/DRAFT/);
  });

  it('cross-site findById → NotFound', async () => {
    const h = build({ inspection: { id: 'insp1', siteId: 'siteB', status: 'DRAFT', items: [], wheelMeasurements: [], recommendations: [], signatures: [] } });
    await expect(h.service.findById('insp1', MGR)).rejects.toThrow(/not found/i);
  });
});

// CR-2026-106 — the template lookup applies the same predicate as the seed,
// deploy-check and /health (docs/121 §C2).
describe('InspectionsService.create — template lookup predicate (CR-2026-106)', () => {
  it('requires items on the top active VEHICLE_INSPECTION row, but not for PRE_INSPECTION', async () => {
    const h = build();
    await h.service.create({ serviceVisitId: 'v1' } as any, MGR);
    const w1 = h.prisma.inspectionTemplate.findFirst.mock.calls[0][0].where;
    expect(w1).toMatchObject({ isActive: true, kind: 'VEHICLE_INSPECTION', items: { some: {} } });

    await h.service.create({ serviceVisitId: 'v1', kind: 'PRE_INSPECTION' } as any, MGR);
    const w2 = h.prisma.inspectionTemplate.findFirst.mock.calls[1][0].where;
    expect(w2).toMatchObject({ isActive: true, kind: 'PRE_INSPECTION' });
    expect(w2).not.toHaveProperty('items');
  });

  it('names the missing form and the remedy when no usable template exists', async () => {
    const h = build();
    h.prisma.inspectionTemplate.findFirst.mockResolvedValue(null);
    await expect(h.service.create({ serviceVisitId: 'v1', kind: 'PRE_INSPECTION' } as any, MGR)).rejects.toThrow(
      /Pre-Job Inspection is not set up for this site.*forms:ensure/s,
    );
  });

  /**
   * CR-2026-107 §13 — the person who can fix it gets the remedy; the person who
   * cannot gets an instruction they can actually follow. Neither gets an id.
   */
  it('gives floor staff a plain instruction and never a technical remedy or an id', async () => {
    const h = build();
    h.prisma.inspectionTemplate.findFirst.mockResolvedValue(null);
    const TECH = { sub: 't1', siteId: 'site1', role: 'TECHNICIAN' };
    let message = '';
    try {
      await h.service.create({ serviceVisitId: 'v1' } as any, TECH);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Vehicle Inspection is not set up for this site.*let a manager know/s);
    expect(message).not.toMatch(/forms:ensure|db:seed|template|uuid|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});
