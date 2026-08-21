import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-071 — edit/delete a service order before work is assigned.
 */
function build() {
  const prisma: any = {
    serviceType: {
      findMany: vi.fn(async ({ where }: any) =>
        (where.code.in as string[]).map((code) => ({ id: `st-${code}`, code, baseDurationMinutes: 30 })),
      ),
    },
    serviceOrderItem: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    serviceOrder: {
      update: vi.fn(async ({ data }: any) => ({ id: 'so-1', ...data })),
      delete: vi.fn(async () => ({})),
    },
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const scheduling = { recomputeQueue: vi.fn(async () => ({})) };
  const service = new ServiceOrdersService(prisma as any, statusHistory as any, audit as any, scheduling as any,
    // CR-2026-088 - KPI hooks. Stubbed: these tests exercise the order state
    // machine, not the KPI framework, which has its own suite.
    {
      assertVehicleClassConfirmed: vi.fn(async () => undefined),
      openSnapshotOnStart: vi.fn(async () => undefined),
      captureSnapshotOnQc: vi.fn(async () => undefined),
      reevaluatePackage: vi.fn(async () => undefined),
      // CR-2026-092 - the pre-start benchmark-readiness check. Stubbed as "nothing
      // missing"; the calculation has its own suite.
      calculateStandardForOrder: vi.fn(async () => ({
        missingQualifiers: [],
        unmappedServiceTypeIds: [],
        finalStandardMinutes: 90,
        benchmarkSource: 'MANAGER_PACKAGE',
      })),
    } as any,
    // CR-2026-090 - work-segment hooks. Stubbed for the same reason: these tests
    // exercise the order state machine, and segments have their own suite.
    {
      startSegment: vi.fn(async () => ({ id: 'seg-1' })),
      endSegment: vi.fn(async () => null),
      endAllForOrder: vi.fn(async () => 0),
      resumeForOrder: vi.fn(async () => 0),
    } as any,
  );
  vi.spyOn(service as any, 'triggerQueueRecompute').mockResolvedValue(undefined);
  return { service, prisma, audit };
}

function order(overrides: any = {}) {
  return {
    id: 'so-1',
    status: 'DRAFT',
    serviceVisitId: 'v1',
    serviceVisit: { siteId: 's1' },
    items: [{ serviceType: { code: 'OIL-01' } }],
    assignments: [],
    ...overrides,
  };
}

describe('updateOrder (CR-2026-071)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('replaces the line items of a DRAFT order', async () => {
    const h = build();
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await h.service.updateOrder('so-1', { items: [{ serviceTypeCode: 'BRK-01' }] }, 'u1');

    expect(h.prisma.serviceOrderItem.deleteMany).toHaveBeenCalledWith({ where: { serviceOrderId: 'so-1' } });
    expect(h.prisma.serviceOrderItem.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ serviceOrderId: 'so-1', serviceTypeId: 'st-BRK-01' })] }),
    );
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SERVICE_ORDER_UPDATED' }));
  });

  it('rejects editing once work is assigned (status ASSIGNED)', async () => {
    const h = build();
    vi.spyOn(h.service, 'findById').mockResolvedValue(order({ status: 'ASSIGNED' }) as any);
    await expect(h.service.updateOrder('so-1', { items: [{ serviceTypeCode: 'BRK-01' }] }, 'u1')).rejects.toThrow(
      /only DRAFT or APPROVED/i,
    );
    expect(h.prisma.serviceOrderItem.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects an empty item list', async () => {
    const h = build();
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);
    await expect(h.service.updateOrder('so-1', { items: [] }, 'u1')).rejects.toThrow(/at least one item/i);
  });
});

describe('deleteOrder (CR-2026-071)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('deletes a DRAFT order with no assignments', async () => {
    const h = build();
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);
    const res = await h.service.deleteOrder('so-1', 'u1');
    expect(h.prisma.serviceOrder.delete).toHaveBeenCalledWith({ where: { id: 'so-1' } });
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SERVICE_ORDER_DELETED' }));
    expect(res).toEqual({ deleted: true });
  });

  it('rejects deleting an IN_PROGRESS order', async () => {
    const h = build();
    vi.spyOn(h.service, 'findById').mockResolvedValue(order({ status: 'IN_PROGRESS' }) as any);
    await expect(h.service.deleteOrder('so-1', 'u1')).rejects.toThrow(/only DRAFT or APPROVED/i);
    expect(h.prisma.serviceOrder.delete).not.toHaveBeenCalled();
  });

  it('rejects deleting an order that still has an active assignment', async () => {
    const h = build();
    vi.spyOn(h.service, 'findById').mockResolvedValue(
      order({ status: 'APPROVED', assignments: [{ endedAt: null, status: 'ASSIGNED' }] }) as any,
    );
    await expect(h.service.deleteOrder('so-1', 'u1')).rejects.toThrow(/technician assigned/i);
    expect(h.prisma.serviceOrder.delete).not.toHaveBeenCalled();
  });
});
