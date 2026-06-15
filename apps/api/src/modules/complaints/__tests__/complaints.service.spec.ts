import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComplaintsService } from '../complaints.service';

/**
 * CR-2026-032 — complaints state machine, race-safe transitions, CMP number
 * generation, SLA-from-config (+ fallback), resolve-notes guard, cross-site IDOR.
 */
const FIXED_CREATED = new Date('2026-06-14T00:00:00.000Z');

function build() {
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ next_val: 1 }]),
    complaint: { create: vi.fn(async (args: any) => ({ id: 'cmp1', ...args.data })) },
  };
  const prisma: any = {
    customer: { findUnique: vi.fn(async () => ({ id: 'cust1' })) },
    site: { findUnique: vi.fn(async () => ({ id: 'site1' })) },
    serviceVisit: { findUnique: vi.fn(async () => ({ id: 'v1' })) },
    serviceOrder: { findUnique: vi.fn(async () => ({ id: 'o1' })) },
    businessRuleConfig: { findFirst: vi.fn(async () => null) },
    complaint: {
      findUnique: vi.fn(async () => ({
        id: 'cmp1', siteId: 'site1', status: 'OPEN', severity: 'MEDIUM',
        type: 'SERVICE_QUALITY', subject: 's', createdAt: FIXED_CREATED, slaDueAt: FIXED_CREATED,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async (args: any) => ({
        id: 'cmp1', siteId: 'site1', status: 'OPEN', severity: 'MEDIUM', type: 'SERVICE_QUALITY',
        subject: 's', createdAt: FIXED_CREATED, ...args.data,
      })),
      count: vi.fn(async () => 0),
    },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const audit = { log: vi.fn(async () => ({})) };
  const statusHistory = { record: vi.fn(async () => ({})), findByEntity: vi.fn(async () => []) };
  const service = new ComplaintsService(prisma as any, audit as any, statusHistory as any);
  return { service, prisma, tx, audit, statusHistory };
}

const MGR = { sub: 'm1', siteId: 'site1', role: 'MANAGER' };
const ADMIN = { sub: 'a1', siteId: null, role: 'ADMIN' };
const baseCreate = { siteId: 'site1', customerId: 'cust1', type: 'SERVICE_QUALITY' as const, subject: 'Bad service', description: 'It was bad' };

describe('ComplaintsService.create (CR-2026-032)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => { h = build(); });

  it('creates OPEN with CMP-000001, default MEDIUM, SLA from fallback (72h), history+audit after the tx', async () => {
    await h.service.create({ ...baseCreate } as any, MGR);
    const data = h.tx.complaint.create.mock.calls[0][0].data;
    expect(data.status).toBe('OPEN');
    expect(data.complaintNumber).toBe('CMP-000001');
    expect(data.severity).toBe('MEDIUM');
    expect(data.createdByUserId).toBe('m1');
    expect(data.slaDueAt).toBeInstanceOf(Date);
    expect(data.slaDueAt.getTime() - Date.now()).toBeGreaterThan(71 * 3600 * 1000); // ~72h default
    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Complaint', fromStatus: null, toStatus: 'OPEN', changedByUserId: 'm1' }),
    );
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'COMPLAINT_CREATED', entityType: 'Complaint' }));
  });

  it('pads the complaint number from the sequence query', async () => {
    h.tx.$queryRaw.mockResolvedValueOnce([{ next_val: 42 }]);
    await h.service.create({ ...baseCreate } as any, MGR);
    expect(h.tx.complaint.create.mock.calls[0][0].data.complaintNumber).toBe('CMP-000042');
  });

  it('uses the BusinessRuleConfig SLA hours map when present', async () => {
    h.prisma.businessRuleConfig.findFirst.mockResolvedValueOnce({ valueJson: { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } });
    await h.service.create({ ...baseCreate } as any, MGR);
    const data = h.tx.complaint.create.mock.calls[0][0].data;
    const hours = (data.slaDueAt.getTime() - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.2);
  });

  it('rejects when the customer does not exist (before any write)', async () => {
    h.prisma.customer.findUnique.mockResolvedValueOnce(null);
    await expect(h.service.create({ ...baseCreate } as any, MGR)).rejects.toThrow(/Customer/);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('ComplaintsService.acknowledge (CR-2026-032)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => { h = build(); });

  it('OPEN→ACKNOWLEDGED via conditional updateMany + history + audit', async () => {
    await h.service.acknowledge('cmp1', MGR);
    expect(h.prisma.complaint.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cmp1', status: 'OPEN' } }),
    );
    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Complaint', fromStatus: 'OPEN', toStatus: 'ACKNOWLEDGED' }),
    );
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'COMPLAINT_ACKNOWLEDGED' }));
  });

  it('throws when not OPEN (updateMany count 0) → no history/audit', async () => {
    h.prisma.complaint.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(h.service.acknowledge('cmp1', MGR)).rejects.toThrow(/not OPEN/);
    expect(h.statusHistory.record).not.toHaveBeenCalled();
  });

  it('cross-site (non-admin) → NotFound; ADMIN bypasses', async () => {
    h.prisma.complaint.findUnique.mockResolvedValue({ id: 'cmp1', siteId: 'siteB' });
    await expect(h.service.acknowledge('cmp1', MGR)).rejects.toThrow(/not found/i);
    await h.service.acknowledge('cmp1', ADMIN); // admin bypass → proceeds
    expect(h.prisma.complaint.updateMany).toHaveBeenCalled();
  });
});

describe('ComplaintsService.resolve (CR-2026-032)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => { h = build(); });

  it('rejects empty / whitespace-only resolutionNotes BEFORE any write', async () => {
    await expect(h.service.resolve('cmp1', MGR, { resolutionNotes: '' } as any)).rejects.toThrow(/required/);
    await expect(h.service.resolve('cmp1', MGR, { resolutionNotes: '   ' } as any)).rejects.toThrow(/required/);
    expect(h.prisma.complaint.updateMany).not.toHaveBeenCalled();
  });

  it('OPEN/ACKNOWLEDGED→RESOLVED via conditional updateMany + history + audit', async () => {
    await h.service.resolve('cmp1', MGR, { resolutionNotes: 'Refunded' } as any);
    expect(h.prisma.complaint.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cmp1', status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }),
    );
    expect(h.statusHistory.record).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'RESOLVED' }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'COMPLAINT_RESOLVED' }));
  });

  it('throws when already RESOLVED (count 0)', async () => {
    h.prisma.complaint.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(h.service.resolve('cmp1', MGR, { resolutionNotes: 'x' } as any)).rejects.toThrow(/already RESOLVED/);
  });
});

describe('ComplaintsService.update (CR-2026-032)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => { h = build(); });

  it('blocks editing a RESOLVED complaint', async () => {
    h.prisma.complaint.findUnique.mockResolvedValueOnce({
      id: 'cmp1', siteId: 'site1', status: 'RESOLVED', severity: 'MEDIUM', type: 'SERVICE_QUALITY', subject: 's', createdAt: FIXED_CREATED,
    });
    await expect(h.service.update('cmp1', { subject: 'x' } as any, MGR)).rejects.toThrow(/RESOLVED/);
    expect(h.prisma.complaint.update).not.toHaveBeenCalled();
  });

  it('severity change recomputes slaDueAt anchored to createdAt; audits before/after; writes NO StatusHistory', async () => {
    await h.service.update('cmp1', { severity: 'HIGH' } as any, MGR);
    const data = h.prisma.complaint.update.mock.calls[0][0].data;
    expect(data.severity).toBe('HIGH');
    // fallback HIGH = 24h, anchored to FIXED_CREATED (not now)
    expect(data.slaDueAt.getTime()).toBe(FIXED_CREATED.getTime() + 24 * 3600 * 1000);
    expect(h.statusHistory.record).not.toHaveBeenCalled();
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'COMPLAINT_UPDATED', afterJson: expect.objectContaining({ slaDueAt: data.slaDueAt }) }),
    );
  });
});
