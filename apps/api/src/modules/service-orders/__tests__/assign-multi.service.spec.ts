import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-068 — multi-order assignment:
 *  - the double-booking guard allows one tech on several orders of the SAME visit,
 *  - assignAllForVisit assigns a tech to every APPROVED order of a visit,
 *  - an assignment can only be edited before work starts (status ASSIGNED).
 */
function build(prismaOverrides: any = {}) {
  const prisma: any = {
    technician: {
      findUnique: vi.fn(async () => ({ id: 'tech-1', status: 'ACTIVE', employeeCode: 'T01', skills: [{ skillCode: 'BRAKE' }] })),
    },
    workBay: {
      findUnique: vi.fn(async () => ({ id: 'bay-1', code: 'B1', bayType: 'GENERAL', status: 'ACTIVE' })),
      findMany: vi.fn(async () => []),
    },
    technicianAssignment: {
      findFirst: vi.fn(async () => null),
      // CR-2026-100 — the workload check lists ALL open assignments on other visits.
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: any) => ({ id: 'ta-1', ...data, technician: {}, bay: {} })),
      update: vi.fn(async ({ data }: any) => ({ id: 'ta-1', ...data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    serviceOrder: {
      update: vi.fn(async ({ data }: any) => ({ id: 'so-1', ...data })),
      findMany: vi.fn(async () => []),
    },
    ...prismaOverrides,
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));
  const statusHistory = { record: vi.fn(async () => ({})) };
  const auditService = { log: vi.fn(async () => ({})) };
  const schedulingService = { recomputeQueue: vi.fn(async () => ({})) };
  const service = new ServiceOrdersService(prisma as any, statusHistory as any, auditService as any, schedulingService as any,
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
      getCalculationBreakdown: vi.fn(async () => ({
        vehicleClass: 'SEDAN_CLASS',
        breakdown: { finalStandardMinutes: 90, lines: [] },
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
  return { service, prisma, auditService };
}

function order(overrides: any = {}) {
  return {
    id: 'so-1',
    status: 'APPROVED',
    serviceVisitId: 'visit-1',
    serviceVisit: { id: 'visit-1', siteId: 'site-1' },
    items: [{ serviceType: { requiredSkillCode: 'BRAKE', requiredBayType: 'GENERAL' } }],
    ...overrides,
  };
}

describe('assign — same-visit double-booking (CR-2026-068)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('excludes the SAME visit from the workload check (allows multi-order on one visit)', async () => {
    const h = build();
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await h.service.assign('so-1', { technicianId: 'tech-1', bayId: 'bay-1' } as any, 'user-1');

    // The workload query must exclude this visit (CR-2026-100 — findMany now).
    expect(h.prisma.technicianAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          technicianId: 'tech-1',
          serviceOrder: { serviceVisitId: { not: 'visit-1' } },
        }),
      }),
    );
    expect(h.prisma.technicianAssignment.create).toHaveBeenCalled();
  });

  // CR-2026-100 — the hard block became a workload warning: the first attempt
  // returns 409 with the technician's open jobs; acknowledgeWorkload proceeds
  // and is audited. A technician CAN legitimately hold several jobs.
  it('surfaces the open workload as a 409 instead of silently assigning', async () => {
    const openJob = {
      id: 'ta-other',
      serviceOrder: {
        id: 'so-other',
        status: 'WAITING_PARTS',
        serviceVisit: {
          vehicle: { plateNumber: 'XYZ999' },
          queueTicket: { ticketNumber: 'B01-260901-001' },
        },
      },
    };
    const h = build({
      technicianAssignment: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [openJob]),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await expect(
      h.service.assign('so-1', { technicianId: 'tech-1', bayId: 'bay-1' } as any, 'user-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'TECHNICIAN_HAS_OPEN_WORK',
        workload: [expect.objectContaining({ orderId: 'so-other', held: true, plate: 'XYZ999' })],
      }),
    });
    expect(h.prisma.technicianAssignment.create).not.toHaveBeenCalled();
  });

  it('acknowledgeWorkload assigns anyway and audits the judgement', async () => {
    const openJob = {
      id: 'ta-other',
      serviceOrder: {
        id: 'so-other',
        status: 'IN_PROGRESS',
        serviceVisit: {
          vehicle: { plateNumber: 'XYZ999' },
          queueTicket: { ticketNumber: 'B01-260901-001' },
        },
      },
    };
    const h = build({
      technicianAssignment: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [openJob]),
        create: vi.fn(async ({ data }: any) => ({ id: 'ta-1', ...data, technician: {}, bay: {} })),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    vi.spyOn(h.service, 'findById').mockResolvedValue(order() as any);

    await h.service.assign(
      'so-1',
      { technicianId: 'tech-1', bayId: 'bay-1', acknowledgeWorkload: true } as any,
      'user-1',
    );

    expect(h.prisma.technicianAssignment.create).toHaveBeenCalled();
    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ASSIGNMENT_WORKLOAD_ACKNOWLEDGED',
        afterJson: expect.objectContaining({ openJobs: 1, active: 1, held: 0 }),
      }),
    );
  });
});

describe('assignAllForVisit (CR-2026-068)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('assigns the technician to every APPROVED order of the visit', async () => {
    const h = build({
      serviceOrder: {
        update: vi.fn(),
        findMany: vi.fn(async () => [{ id: 'so-1' }, { id: 'so-2' }]),
      },
    });
    const assignSpy = vi.spyOn(h.service, 'assign').mockResolvedValue({ id: 'ok' } as any);

    const res = await h.service.assignAllForVisit('visit-1', 'tech-1', 'user-1');

    expect(assignSpy).toHaveBeenCalledTimes(2);
    expect(assignSpy).toHaveBeenCalledWith('so-1', { technicianId: 'tech-1' }, 'user-1');
    expect(assignSpy).toHaveBeenCalledWith('so-2', { technicianId: 'tech-1' }, 'user-1');
    expect(res).toHaveLength(2);
  });

  it('throws when the visit has no approved orders', async () => {
    const h = build({ serviceOrder: { update: vi.fn(), findMany: vi.fn(async () => []) } });
    await expect(h.service.assignAllForVisit('visit-1', 'tech-1', 'user-1')).rejects.toThrow(/no approved/i);
  });
});

describe('updateAssignment — edit only before work starts (CR-2026-068)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('allows editing an ASSIGNED (not started) assignment', async () => {
    const h = build({
      technicianAssignment: {
        findFirst: vi.fn(async () => ({ id: 'ta-1', status: 'ASSIGNED', technicianId: 'tech-1', isPrimary: true })),
        update: vi.fn(async ({ data }: any) => ({ id: 'ta-1', ...data })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    await h.service.updateAssignment('so-1', 'ta-1', { technicianId: 'tech-2' }, 'user-1');
    expect(h.prisma.technicianAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ technicianId: 'tech-2' }) }),
    );
  });

  it('blocks editing once work has started (status IN_PROGRESS)', async () => {
    const h = build({
      technicianAssignment: {
        findFirst: vi.fn(async () => ({ id: 'ta-1', status: 'IN_PROGRESS', technicianId: 'tech-1', isPrimary: true })),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    });
    await expect(h.service.updateAssignment('so-1', 'ta-1', { technicianId: 'tech-2' }, 'user-1')).rejects.toThrow(
      /work has already started/i,
    );
    expect(h.prisma.technicianAssignment.update).not.toHaveBeenCalled();
  });
});
