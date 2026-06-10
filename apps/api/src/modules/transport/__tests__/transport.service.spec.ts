import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TransportService } from '../transport.service';

/**
 * P2 — Transport dispatch UI wiring. Covers the read-only additions
 * (getDispatchBoard recentlyClosed bucket, getDrivers) plus the existing
 * eligibility + transition guards the UI relies on. Mocked PrismaService.
 */
function visitRow(eligible: boolean) {
  return {
    id: 'sv-1',
    appointment: { services: [{ serviceType: { transportEligible: eligible } }] },
  };
}

function dispatchRow(status: string) {
  return {
    id: `tr-${status}`,
    serviceVisitId: 'sv-1',
    direction: 'PICKUP',
    status,
    requestedPickupAt: null,
    scheduledPickupAt: null,
    completedAt: null,
    serviceVisit: {
      customer: { firstName: 'Test', lastName: 'Customer' },
      vehicle: { plateNumber: 'ABC123', make: 'Toyota', model: 'Corolla' },
    },
    driver: null,
  };
}

function build() {
  const prisma: any = {
    serviceVisit: { findUnique: vi.fn() },
    transportRequest: {
      create: vi.fn(async ({ data }: any) => ({ id: 'tr-1', ...data })),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(async ({ data }: any) => ({ id: 'tr-1', ...data })),
    },
    userAccount: { findMany: vi.fn(async () => [{ id: 'u1', fullName: 'Aaa', roleCode: 'TRANSPORT_COORDINATOR' }]) },
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const service = new TransportService(prisma as any, statusHistory as any);
  return { service, prisma, statusHistory };
}

describe('TransportService (P2 dispatch UI wiring)', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => { h = build(); });

  it('create rejects a visit with no transport-eligible service', async () => {
    h.prisma.serviceVisit.findUnique.mockResolvedValue(visitRow(false));
    await expect(
      h.service.create({ serviceVisitId: 'sv-1', direction: 'PICKUP' } as any, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.transportRequest.create).not.toHaveBeenCalled();
  });

  it('create succeeds for an eligible visit and records status history', async () => {
    h.prisma.serviceVisit.findUnique.mockResolvedValue(visitRow(true));
    const r = await h.service.create({ serviceVisitId: 'sv-1', direction: 'PICKUP' } as any, 'user-1');
    expect(r).toMatchObject({ status: 'REQUESTED', serviceVisitId: 'sv-1' });
    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'TransportRequest', toStatus: 'REQUESTED', changedByUserId: 'user-1' }),
    );
  });

  it('getDispatchBoard groups active buckets and includes recentlyClosed', async () => {
    h.prisma.transportRequest.findMany
      .mockResolvedValueOnce([dispatchRow('REQUESTED'), dispatchRow('SCHEDULED'), dispatchRow('IN_PROGRESS')]) // active
      .mockResolvedValueOnce([dispatchRow('COMPLETED'), dispatchRow('CANCELLED')]); // closed

    const board: any = await h.service.getDispatchBoard('site-1');
    expect(board.pending.map((x: any) => x.status)).toEqual(['REQUESTED']);
    expect(board.scheduled.map((x: any) => x.status)).toEqual(['SCHEDULED']);
    expect(board.inProgress.map((x: any) => x.status)).toEqual(['IN_PROGRESS']);
    expect(board.recentlyClosed.map((x: any) => x.status)).toEqual(['COMPLETED', 'CANCELLED']);
    // mapItem surfaces visit ref + vehicle description for the operator screen.
    expect(board.pending[0]).toMatchObject({ serviceVisitId: 'sv-1', vehiclePlate: 'ABC123', vehicleDescription: 'Toyota Corolla' });
  });

  it('getDrivers returns active staff candidates', async () => {
    const drivers = await h.service.getDrivers();
    expect(h.prisma.userAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE' }, orderBy: { fullName: 'asc' } }),
    );
    expect(drivers[0]).toMatchObject({ id: 'u1' });
  });

  it('rejects an invalid lifecycle transition (start before driver assigned)', async () => {
    h.prisma.transportRequest.findUnique.mockResolvedValue({ id: 'tr-1', status: 'REQUESTED' });
    await expect(h.service.start('tr-1', 'user-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.transportRequest.update).not.toHaveBeenCalled();
  });

  it('allows a valid transition (complete from in-progress)', async () => {
    h.prisma.transportRequest.findUnique.mockResolvedValue({ id: 'tr-1', status: 'IN_PROGRESS' });
    const r = await h.service.complete('tr-1', 'user-1');
    expect(r).toMatchObject({ status: 'COMPLETED' });
    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'TransportRequest', toStatus: 'COMPLETED' }),
    );
  });
});
