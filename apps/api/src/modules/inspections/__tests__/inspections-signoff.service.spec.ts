import { describe, it, expect, vi } from 'vitest';
import { InspectionsService } from '../inspections.service';

/**
 * CR-2026-034 (C-3) — sign-off, customer decisions, customer sign-off, signatures,
 * and immutability after SIGNED_OFF. Transitions use conditional updateMany +
 * signature create inside one transaction.
 */
function build(over: { inspection?: any; txUpdateCount?: number; rec?: any } = {}) {
  const inspection = 'inspection' in over ? over.inspection : {
    id: 'insp1', siteId: 'site1', status: 'SIGNED_OFF',
    items: [], wheelMeasurements: [], recommendations: [], signatures: [], customer: null, vehicle: null, serviceVisit: null,
  };
  const tx: any = {
    vehicleInspection: { updateMany: vi.fn(async () => ({ count: over.txUpdateCount ?? 1 })) },
    inspectionSignature: { create: vi.fn(async (a: any) => ({ id: 'sig1', ...a.data })) },
  };
  const prisma: any = {
    vehicleInspection: { findUnique: vi.fn(async () => inspection) },
    inspectionRecommendation: {
      findFirst: vi.fn(async () => ('rec' in over ? over.rec : { id: 'rec1' })),
      update: vi.fn(async (a: any) => ({ id: 'rec1', ...a.data })),
    },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const audit = { log: vi.fn(async () => ({})) };
  const statusHistory = { record: vi.fn(async () => ({})), findByEntity: vi.fn(async () => []) };
  const service = new InspectionsService(prisma as any, audit as any, statusHistory as any);
  return { service, prisma, tx, audit, statusHistory };
}

const MGR = { sub: 'm1', siteId: 'site1', role: 'MANAGER' };

describe('InspectionsService.signoff (C-3)', () => {
  it('COMPLETED→SIGNED_OFF: conditional updateMany + SENIOR_TECH typed signature + history + audit', async () => {
    const h = build();
    await h.service.signoff('insp1', MGR, { typedName: 'Tech Tom' } as any);
    expect(h.tx.vehicleInspection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'insp1', status: 'COMPLETED' } }));
    expect(h.tx.inspectionSignature.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'SENIOR_TECH', type: 'TYPED', typedName: 'Tech Tom', signedByUserId: 'm1' }) }));
    expect(h.statusHistory.record).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: 'COMPLETED', toStatus: 'SIGNED_OFF' }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INSPECTION_SIGNED_OFF' }));
  });

  it('rejects empty typed acknowledgment before any write', async () => {
    const h = build();
    await expect(h.service.signoff('insp1', MGR, { typedName: '   ' } as any)).rejects.toThrow(/typed acknowledgment/);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when not COMPLETED (tx updateMany count 0)', async () => {
    const h = build({ txUpdateCount: 0 });
    await expect(h.service.signoff('insp1', MGR, { typedName: 'Tom' } as any)).rejects.toThrow(/must be COMPLETED/);
  });

  it('cross-site → NotFound', async () => {
    const h = build({ inspection: { id: 'insp1', siteId: 'siteB' } });
    await expect(h.service.signoff('insp1', MGR, { typedName: 'Tom' } as any)).rejects.toThrow(/not found/i);
  });
});

describe('InspectionsService.decideRecommendation (C-3)', () => {
  it('records the decision while SIGNED_OFF + audits', async () => {
    const h = build();
    const r = await h.service.decideRecommendation('insp1', 'rec1', MGR, { decision: 'APPROVED' } as any);
    expect(h.prisma.inspectionRecommendation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'rec1' }, data: expect.objectContaining({ customerDecision: 'APPROVED', decisionByUserId: 'm1' }) }));
    expect(r.customerDecision).toBe('APPROVED');
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INSPECTION_RECOMMENDATION_DECISION' }));
  });

  it('blocks decisions unless SIGNED_OFF', async () => {
    const h = build({ inspection: { id: 'insp1', siteId: 'site1', status: 'COMPLETED' } });
    await expect(h.service.decideRecommendation('insp1', 'rec1', MGR, { decision: 'DECLINED' } as any)).rejects.toThrow(/after sign-off/);
  });

  it('404s a recommendation not on this inspection', async () => {
    const h = build({ rec: null });
    await expect(h.service.decideRecommendation('insp1', 'recX', MGR, { decision: 'DEFERRED' } as any)).rejects.toThrow(/Recommendation not found/);
  });
});

describe('InspectionsService.customerSignoff (C-3)', () => {
  it('DRAWN requires imageData; TYPED requires typedName (rejected before write)', async () => {
    const h = build();
    await expect(h.service.customerSignoff('insp1', MGR, { type: 'DRAWN' } as any)).rejects.toThrow(/drawn signature image/);
    await expect(h.service.customerSignoff('insp1', MGR, { type: 'TYPED' } as any)).rejects.toThrow(/typed name/);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('DRAWN valid: SIGNED_OFF→CLOSED + CUSTOMER signature + history + audit', async () => {
    const h = build();
    await h.service.customerSignoff('insp1', MGR, { type: 'DRAWN', imageData: 'data:image/png;base64,AAAA' } as any);
    expect(h.tx.vehicleInspection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'insp1', status: 'SIGNED_OFF' } }));
    expect(h.tx.inspectionSignature.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'CUSTOMER', type: 'DRAWN', imageData: 'data:image/png;base64,AAAA' }) }));
    expect(h.statusHistory.record).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: 'SIGNED_OFF', toStatus: 'CLOSED' }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'INSPECTION_CUSTOMER_SIGNED' }));
  });

  it('rejects when not SIGNED_OFF (tx updateMany count 0)', async () => {
    const h = build({ txUpdateCount: 0 });
    await expect(h.service.customerSignoff('insp1', MGR, { type: 'TYPED', typedName: 'Jane' } as any)).rejects.toThrow(/must be SIGNED_OFF/);
  });
});

describe('InspectionsService immutability after sign-off (C-3)', () => {
  it('update() is rejected once SIGNED_OFF (results locked)', async () => {
    const h = build({ inspection: { id: 'insp1', siteId: 'site1', status: 'SIGNED_OFF' } });
    await expect(h.service.update('insp1', { comments: 'x' } as any, MGR)).rejects.toThrow(/DRAFT/);
  });
});
