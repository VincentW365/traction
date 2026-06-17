import { describe, it, expect, vi } from 'vitest';
import { ScheduleService } from '../schedule.service';

/**
 * CR-2026-045 — walk-ins appear on the Appointments calendar, placed by arrival
 * time (checked_in_at). getDaySchedule returns a `walkIns` projection and the
 * Walk-Ins stat counts all walk-ins checked in that day.
 */
function build(walkInVisits: unknown[]) {
  // serviceVisit.findMany is called 3×: completedVisits, readyForPickup, walkInVisits.
  const serviceVisitFindMany = vi
    .fn()
    .mockResolvedValueOnce([]) // completedVisits
    .mockResolvedValueOnce([]) // readyForPickup
    .mockResolvedValueOnce(walkInVisits); // walkInVisits
  const prisma: any = {
    businessRuleConfig: { findFirst: vi.fn(async () => null) },
    workResource: { findMany: vi.fn(async () => []) },
    resourceReservation: { findMany: vi.fn(async () => []) },
    resourceOccupancy: { findMany: vi.fn(async () => []) },
    serviceVisit: { findMany: serviceVisitFindMany },
    queueTicket: { findMany: vi.fn(async () => []) },
    technicianAssignment: { findMany: vi.fn(async () => []) },
    appointment: { count: vi.fn(async () => 3) },
  };
  return { service: new ScheduleService(prisma as any), serviceVisitFindMany };
}

describe('ScheduleService.getDaySchedule — walk-ins (CR-2026-045)', () => {
  it('maps walk-in visits by arrival and counts them in stats', async () => {
    const { service, serviceVisitFindMany } = build([
      {
        id: 'sv-1',
        sourceType: 'WALKIN',
        status: 'QUEUED',
        checkedInAt: new Date('2026-06-17T14:00:00Z'),
        customer: { firstName: 'Jane', lastName: 'Doe' },
        vehicle: { plateNumber: 'ABC123' },
        queueTicket: { id: 'tk-1', ticketNumber: 'W005' },
      },
    ]);

    const res = await service.getDaySchedule('site-1', '2026-06-17');

    expect(res.walkIns).toHaveLength(1);
    expect(res.walkIns[0]).toMatchObject({
      serviceVisitId: 'sv-1',
      ticketId: 'tk-1',
      ticketNumber: 'W005',
      customerName: 'Jane Doe',
      vehiclePlate: 'ABC123',
      status: 'QUEUED',
    });
    expect(res.walkIns[0].checkedInAt).toBe('2026-06-17T14:00:00.000Z');
    expect(res.stats.walkIns).toBe(1);

    // The walk-in query filters sourceType WALKIN and excludes test-data rows.
    const walkWhere = serviceVisitFindMany.mock.calls[2][0].where;
    expect(walkWhere.sourceType).toBe('WALKIN');
    expect(walkWhere.testDataRunId).toBeNull();
  });

  it('returns an empty walk-in list (and zero stat) when none checked in', async () => {
    const { service } = build([]);
    const res = await service.getDaySchedule('site-1', '2026-06-17');
    expect(res.walkIns).toEqual([]);
    expect(res.stats.walkIns).toBe(0);
  });
});
