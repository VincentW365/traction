import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-069 — the assigned mechanic (not the front desk / manager) starts the work,
 * and can list their own not-yet-started assignments.
 */
function build(opts: { assignment?: any; callerTech?: any; order?: any; myAssignments?: any[] } = {}) {
  const prisma: any = {
    technicianAssignment: {
      findFirst: vi.fn(async () => opts.assignment ?? null),
      update: vi.fn(async ({ data }: any) => ({ id: 'ta-1', ...data })),
      findMany: vi.fn(async () => opts.myAssignments ?? []),
    },
    technician: { findUnique: vi.fn(async () => opts.callerTech ?? null) },
    serviceOrder: { findUnique: vi.fn(async () => opts.order ?? { id: 'so-1', status: 'ASSIGNED' }) },
  };
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
  vi.spyOn(service as any, 'changeStatus').mockResolvedValue({});
  return { service, prisma };
}

describe('startAssignment — mechanic starts their own work (CR-2026-069)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lets the ASSIGNED technician start (records startedAt + IN_PROGRESS)', async () => {
    const h = build({
      assignment: { id: 'ta-1', technicianId: 'tech-1', status: 'ASSIGNED' },
      callerTech: { id: 'tech-1' },
    });
    await h.service.startAssignment('so-1', 'ta-1', 'user-1');
    expect(h.prisma.technicianAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_PROGRESS' }) }),
    );
  });

  it('rejects a caller who is NOT the assigned technician', async () => {
    const h = build({
      assignment: { id: 'ta-1', technicianId: 'tech-1', status: 'ASSIGNED' },
      callerTech: { id: 'tech-2' },
    });
    await expect(h.service.startAssignment('so-1', 'ta-1', 'user-2')).rejects.toThrow(/assigned technician/i);
    expect(h.prisma.technicianAssignment.update).not.toHaveBeenCalled();
  });

  it('rejects a non-technician (e.g. manager) with no technician record', async () => {
    const h = build({
      assignment: { id: 'ta-1', technicianId: 'tech-1', status: 'ASSIGNED' },
      callerTech: null,
    });
    await expect(h.service.startAssignment('so-1', 'ta-1', 'admin-1')).rejects.toThrow(/assigned technician/i);
    expect(h.prisma.technicianAssignment.update).not.toHaveBeenCalled();
  });
});

describe('getMyAssignments (CR-2026-069)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns [] for a non-technician user', async () => {
    const h = build({ callerTech: null });
    const res = await h.service.getMyAssignments('user-1');
    expect(res).toEqual([]);
  });

  it('maps the technician\'s assignments to a floor-friendly shape', async () => {
    const h = build({
      callerTech: { id: 'tech-1' },
      myAssignments: [
        {
          id: 'ta-1',
          serviceOrderId: 'so-1',
          bay: { code: 'B1' },
          serviceOrder: {
            status: 'ASSIGNED',
            serviceVisitId: 'visit-1',
            items: [{ serviceType: { name: 'Brake Pads' } }],
            serviceVisit: {
              customer: { firstName: 'Ann', lastName: 'Lee' },
              vehicle: { plateNumber: 'ABC123', make: 'Toyota', model: 'Corolla' },
              queueTicket: { ticketNumber: 'A007' },
            },
          },
        },
      ],
    });
    const res = await h.service.getMyAssignments('user-1');
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual(
      expect.objectContaining({
        assignmentId: 'ta-1',
        orderId: 'so-1',
        ticketNumber: 'A007',
        customerName: 'Ann Lee',
        vehicle: 'Toyota Corolla',
        plate: 'ABC123',
        bay: 'B1',
        services: ['Brake Pads'],
      }),
    );
  });
});
