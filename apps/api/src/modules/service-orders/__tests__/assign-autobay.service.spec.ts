import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-062 — technician assignment bay auto-assign.
 * When the assign DTO omits bayId, the service must pick the first ACTIVE bay that
 * matches the order's required bay type(s) and has no active assignment. A provided
 * bayId still works as before.
 */
function buildService(prismaOverrides: any = {}) {
  const prisma: any = {
    technician: {
      findUnique: vi.fn(async () => ({
        id: 'tech-1',
        status: 'ACTIVE',
        employeeCode: 'T01',
        skills: [{ skillCode: 'BRAKE' }],
      })),
    },
    workBay: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    technicianAssignment: {
      // tech double-booking check → null (free); bay availability decided per test
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: 'ta-1', ...data, technician: {}, bay: {} })),
    },
    serviceOrder: {
      update: vi.fn(async ({ data }: any) => ({ id: 'so-1', ...data })),
    },
    ...prismaOverrides,
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));

  const statusHistory = { record: vi.fn(async () => ({})) };
  const auditService = { log: vi.fn(async () => ({})) };
  const schedulingService = { recomputeQueue: vi.fn(async () => ({})) };

  const service = new ServiceOrdersService(
    prisma as any,
    statusHistory as any,
    auditService as any,
    schedulingService as any,
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
  return { service, prisma };
}

function order(overrides: any = {}) {
  return {
    id: 'so-1',
    status: 'APPROVED',
    serviceVisitId: 'sv-1',
    serviceVisit: { id: 'sv-1', siteId: 'site-1' },
    items: [{ serviceType: { requiredSkillCode: 'BRAKE', requiredBayType: 'GENERAL' } }],
    ...overrides,
  };
}

describe('ServiceOrder assign — bay auto-assign (CR-2026-062)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('auto-assigns the first compatible FREE bay when bayId is omitted', async () => {
    const h = buildService({
      workBay: {
        findUnique: vi.fn(),
        findMany: vi.fn(async () => [
          { id: 'bay-1', code: 'B1', bayType: 'GENERAL', status: 'ACTIVE' },
          { id: 'bay-2', code: 'B2', bayType: 'GENERAL', status: 'ACTIVE' },
        ]),
      },
      technicianAssignment: {
        findFirst: vi.fn(async ({ where }: any) => {
          if (where.technicianId) return null; // tech not double-booked
          if (where.bayId === 'bay-1') return { id: 'occupied' }; // bay-1 busy
          return null; // bay-2 free
        }),
        create: vi.fn(async ({ data }: any) => ({ id: 'ta-1', ...data, technician: {}, bay: {} })),
      },
    });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await h.service.assign('so-1', { technicianId: 'tech-1' } as any, 'user-1');

    // Only the free, compatible bay (bay-2) is used; bay-1 was busy.
    expect(h.prisma.technicianAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bayId: 'bay-2' }) }),
    );
    // Compatible-bay query filtered by the order's required bay type at the site.
    expect(h.prisma.workBay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ siteId: 'site-1', status: 'ACTIVE', bayType: { in: ['GENERAL'] } }) }),
    );
  });

  it('throws when no compatible bay is free', async () => {
    const h = buildService({
      workBay: {
        findUnique: vi.fn(),
        findMany: vi.fn(async () => [{ id: 'bay-1', code: 'B1', bayType: 'GENERAL', status: 'ACTIVE' }]),
      },
      technicianAssignment: {
        findFirst: vi.fn(async ({ where }: any) => (where.technicianId ? null : { id: 'busy' })),
        create: vi.fn(),
      },
    });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await expect(h.service.assign('so-1', { technicianId: 'tech-1' } as any, 'user-1')).rejects.toThrow(
      /no compatible free bay/i,
    );
    expect(h.prisma.technicianAssignment.create).not.toHaveBeenCalled();
  });

  it('with no required bay type, auto-assigns any active free bay', async () => {
    const findMany = vi.fn(async () => [{ id: 'bay-x', code: 'BX', bayType: 'DIAGNOSTIC', status: 'ACTIVE' }]);
    const h = buildService({
      workBay: { findUnique: vi.fn(), findMany },
      technicianAssignment: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => ({ id: 'ta-1', ...data, technician: {}, bay: {} })),
      },
    });
    vi.spyOn(h.service, 'findById').mockResolvedValue(
      order({ items: [{ serviceType: { requiredSkillCode: null, requiredBayType: null } }] }) as any,
    );

    await h.service.assign('so-1', { technicianId: 'tech-1' } as any, 'user-1');

    // No bayType filter when the order has no required bay type.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ siteId: 'site-1', status: 'ACTIVE' }) }),
    );
    const firstCallWhere = (findMany.mock.calls as any[])[0][0].where;
    expect(firstCallWhere).not.toHaveProperty('bayType');
    expect(h.prisma.technicianAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bayId: 'bay-x' }) }),
    );
  });

  it('still honors an explicitly provided bayId', async () => {
    const h = buildService({
      workBay: {
        findUnique: vi.fn(async () => ({ id: 'bay-9', code: 'B9', bayType: 'GENERAL', status: 'ACTIVE' })),
        findMany: vi.fn(async () => []),
      },
    });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await h.service.assign('so-1', { technicianId: 'tech-1', bayId: 'bay-9' } as any, 'user-1');

    expect(h.prisma.workBay.findUnique).toHaveBeenCalledWith({ where: { id: 'bay-9' } });
    expect(h.prisma.workBay.findMany).not.toHaveBeenCalled(); // no auto-pick path
    expect(h.prisma.technicianAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bayId: 'bay-9' }) }),
    );
  });
});
