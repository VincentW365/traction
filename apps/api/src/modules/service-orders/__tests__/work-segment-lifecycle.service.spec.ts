import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-090 — the order state machine drives the labour clock.
 *
 * WorkSegmentService has its own suite for how a segment behaves. What is tested
 * here is the wiring: that the labour clock stops and starts at the same moments the
 * work does. Each of these is a gap that would otherwise show up as a technician
 * credited with hours they did not work — pausing a job and leaving segments open is
 * the clearest example, and it is invisible until someone reads a report weeks later.
 */
function buildService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    serviceOrder: {
      update: vi.fn(async ({ data }: any) => ({
        id: 'so-1',
        serviceVisitId: 'sv-1',
        ...data,
      })),
      findUnique: vi.fn(async () => ({ id: 'so-1', status: 'ASSIGNED', isPrimary: true })),
      count: vi.fn(async () => 0),
    },
    serviceOrderItem: {
      findFirst: vi.fn(async () => ({
        id: 'soi-1',
        serviceOrderId: 'so-1',
        axlePosition: null,
        serviceType: { code: 'BRK-02', name: 'Brake Pad Replacement' },
      })),
      update: vi.fn(async ({ data }: any) => ({
        id: 'soi-1',
        ...data,
        serviceType: { code: 'BRK-02', name: 'Brake Pad Replacement' },
      })),
    },
    serviceOrderPause: {
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    serviceVisit: { update: vi.fn(async () => ({})) },
    technicianAssignment: {
      findFirst: vi.fn(async () => ({
        id: 'ta-1',
        technicianId: 'tech-1',
        status: 'ASSIGNED',
        isPrimary: true,
      })),
      update: vi.fn(async () => ({ id: 'ta-1' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    technician: { findUnique: vi.fn(async () => ({ id: 'tech-1' })) },
    resourceOccupancy: { updateMany: vi.fn(async () => ({ count: 0 })) },
    queueTicket: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    ...overrides,
  };
  prisma.$transaction = vi.fn(async (cb: any) => cb(prisma));

  const segments = {
    startSegment: vi.fn(async () => ({ id: 'seg-1' })),
    endSegment: vi.fn(async () => null),
    endAllForOrder: vi.fn(async () => 1),
    resumeForOrder: vi.fn(async () => 1),
  };
  const kpi = {
    assertVehicleClassConfirmed: vi.fn(async () => undefined),
    openSnapshotOnStart: vi.fn(async () => undefined),
    captureSnapshotOnQc: vi.fn(async () => undefined),
    reevaluatePackage: vi.fn(async () => undefined),
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
  };
  const auditService = { log: vi.fn(async () => ({})) };

  const service = new ServiceOrdersService(
    prisma as any,
    { record: vi.fn(async () => ({})) } as any,
    auditService as any,
    { recomputeQueue: vi.fn(async () => ({})) } as any,
    kpi as any,
    segments as any,
  );
  vi.spyOn(service as any, 'triggerQueueRecompute').mockResolvedValue(undefined);

  return { service, prisma, segments, kpi, auditService };
}

const orderIn = (status: string) => ({
  id: 'so-1',
  status,
  serviceVisitId: 'sv-1',
  assignments: [{ id: 'ta-1', technicianId: 'tech-1', endedAt: null }],
  serviceVisit: { id: 'sv-1', siteId: 'site-1' },
  items: [],
});

describe('the labour clock follows the work', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('starting work opens a segment for that technician', async () => {
    const h = buildService();
    vi.spyOn(h.service as any, 'changeStatus').mockResolvedValue({});

    await h.service.startAssignment('so-1', 'ta-1', 'user-1');

    expect(h.segments.startSegment).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceOrderId: 'so-1',
        technicianId: 'tech-1',
        role: 'PRIMARY',
        startSource: 'TECHNICIAN_START',
      }),
    );
  });

  it('pausing closes every open segment, inside the pause transaction', async () => {
    // In the same transaction as the pause itself: a pause recorded without its
    // segments closed leaves technicians accruing labour through time the job was
    // explicitly stopped.
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('IN_PROGRESS') as never);

    await h.service.pause('so-1', { reasonCode: 'WAITING_PARTS' } as never, 'user-1');

    expect(h.segments.endAllForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: 'so-1', endReason: 'PAUSED' }),
      expect.anything(),
    );
  });

  it('resuming reopens segments for whoever is still assigned', async () => {
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('PAUSED') as never);

    await h.service.resume('so-1', {} as never, 'user-1');

    expect(h.segments.resumeForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ serviceOrderId: 'so-1' }),
      expect.anything(),
    );
  });

  it('submitting to QC closes every open segment', async () => {
    // Including an assistant who never pressed anything themselves.
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('IN_PROGRESS') as never);
    vi.spyOn(h.service as any, 'changeStatus').mockResolvedValue({});

    await h.service.readyForQc('so-1', 'user-1');

    expect(h.segments.endAllForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ endReason: 'SUBMITTED_TO_QC' }),
    );
  });

  it('taking a technician off a live job closes only their segment', async () => {
    const h = buildService();

    await h.service.removeAssignment('so-1', 'ta-1', 'user-1');

    expect(h.segments.endSegment).toHaveBeenCalledWith(
      expect.objectContaining({ technicianId: 'tech-1', endReason: 'REASSIGNED' }),
    );
    expect(h.segments.endAllForOrder).not.toHaveBeenCalled();
  });

  it('ending an assistant’s own assignment closes only their segment', async () => {
    const h = buildService();

    await h.service.endAssignment('so-1', 'ta-1', 'user-1');

    expect(h.segments.endSegment).toHaveBeenCalledWith(
      expect.objectContaining({ endReason: 'ASSISTANCE_COMPLETE' }),
    );
  });

  it('cancelling a job stops the clock', async () => {
    // Otherwise an open segment on a cancelled order keeps accruing against "now"
    // every time a report runs, and the labour grows for a job nobody is doing.
    const h = buildService();
    vi.spyOn(h.service, 'findById').mockResolvedValue(orderIn('APPROVED') as never);

    await h.service.changeStatus('so-1', { toStatus: 'CANCELLED' } as never, 'user-1');

    expect(h.segments.endAllForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ endReason: 'JOB_CANCELLED' }),
    );
  });
});

describe('recording the axle on a service line (CR-2026-090)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('records the axle and re-evaluates the package', async () => {
    // The re-evaluation IS the point: a job blocked only by a missing axle becomes
    // benchmarked the moment the axle is known.
    const h = buildService();

    await h.service.setItemAxle('so-1', 'soi-1', 'FRONT', 'user-1');

    expect(h.prisma.serviceOrderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { axlePosition: 'FRONT' } }),
    );
    expect(h.kpi.reevaluatePackage).toHaveBeenCalledWith('so-1', 'user-1');
  });

  it('audits the change with the previous value', async () => {
    const h = buildService();

    await h.service.setItemAxle('so-1', 'soi-1', 'REAR', 'user-1');

    expect(h.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SERVICE_LINE_AXLE_SET',
        beforeJson: { axlePosition: null },
      }),
    );
  });

  it('does nothing when the axle is already what was asked for', async () => {
    const h = buildService({
      serviceOrderItem: {
        findFirst: vi.fn(async () => ({
          id: 'soi-1',
          serviceOrderId: 'so-1',
          axlePosition: 'FRONT',
          serviceType: { code: 'BRK-02', name: 'Brake Pad Replacement' },
        })),
        update: vi.fn(),
      },
    });

    await h.service.setItemAxle('so-1', 'soi-1', 'FRONT', 'user-1');

    expect(h.prisma.serviceOrderItem.update).not.toHaveBeenCalled();
    expect(h.kpi.reevaluatePackage).not.toHaveBeenCalled();
  });

  it('refuses a line that is not on the order', async () => {
    const h = buildService({
      serviceOrderItem: { findFirst: vi.fn(async () => null), update: vi.fn() },
    });

    await expect(
      h.service.setItemAxle('so-1', 'soi-9', 'FRONT', 'user-1'),
    ).rejects.toThrow(/not found/i);
  });
});
