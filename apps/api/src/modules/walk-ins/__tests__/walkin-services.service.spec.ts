import { describe, it, expect, vi } from 'vitest';
import { WalkInsService } from '../walk-ins.service';

/**
 * CR-2026-084 — a walk-in must record what it came in for.
 *
 * The selected service codes used to be validated and then thrown away: nothing in
 * the walk-in transaction persisted them, and ServiceVisit has no place to put them.
 * Every "Services" display therefore fell back to the literal "Walk-in service", and
 * staff had to re-pick the same services by hand to raise the work order. The walk-in
 * now produces the same DRAFT ServiceOrder an appointment does.
 */
function build() {
  const tx: any = {
    // CR-2026-097 — `update` sets visitNumber to the ticket reference post-issue.
    serviceVisit: { create: vi.fn(async () => ({ id: 'sv1', customer: {}, vehicle: {} })), update: vi.fn(async () => ({})) },
    queueTicket: { create: vi.fn(async () => ({ id: 'qt1', ticketNumber: 'QTK-BERT-01-20260820-0001' })) },
    serviceOrder: {
      create: vi.fn(async () => ({ id: 'so1', items: [{ id: 'i1' }, { id: 'i2' }] })),
    },
    vehicle: { update: vi.fn(async () => ({})) },
    // Consumed by generateTicketNumber inside the transaction.
    $queryRaw: vi.fn(async () => [{ next_seq: 1 }]),
  };

  const prisma: any = {
    site: { findUnique: vi.fn(async () => ({ id: 's1', code: 'BERT-01', timezone: 'America/Jamaica', isActive: true })) },
    customer: {
      findUnique: vi.fn(async () => ({
        id: 'c1', firstName: 'A', lastName: 'B', phone: 'x',
        notificationOptInSms: false, notificationOptInEmail: false,
      })),
      update: vi.fn(async () => ({})),
    },
    vehicle: {
      findUnique: vi.fn(async () => ({
        id: 'v1', customerId: 'c1', plateNumber: 'P', make: 'M', model: 'Mo', modelYear: 2015,
      })),
      update: vi.fn(async () => ({})),
    },
    serviceType: {
      findMany: vi.fn(async () => [
        { id: 'st-oil', code: 'OIL-01', baseDurationMinutes: 30, requiresMileage: true },
        { id: 'st-tyre', code: 'TYRE-01', baseDurationMinutes: 20, requiresMileage: false },
      ]),
    },
    serviceVisit: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };

  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new WalkInsService(prisma as any, statusHistory as any, audit as any);
  return { service, prisma, tx, statusHistory, audit };
}

const dto = (over: Record<string, unknown> = {}) => ({
  siteId: 's1',
  customerId: 'c1',
  vehicleId: 'v1',
  serviceTypes: [{ serviceTypeCode: 'OIL-01' }, { serviceTypeCode: 'TYRE-01' }],
  mileageIn: 45230,
  ...over,
}) as any;

describe('CR-2026-084 — walk-in records its services', () => {
  it('raises a DRAFT service order containing every selected service', async () => {
    const h = build();

    await h.service.register(dto(), 'user-1');

    expect(h.tx.serviceOrder.create).toHaveBeenCalledTimes(1);
    const arg = h.tx.serviceOrder.create.mock.calls[0][0];
    expect(arg.data.serviceVisitId).toBe('sv1');
    expect(arg.data.status).toBe('DRAFT');
    expect(arg.data.advisorUserId).toBe('user-1');
    expect(arg.data.items.create).toEqual([
      { serviceTypeId: 'st-oil', estimateMinutes: 30 },
      { serviceTypeId: 'st-tyre', estimateMinutes: 20 },
    ]);
  });

  it('de-duplicates a service picked twice', async () => {
    const h = build();

    await h.service.register(
      dto({ serviceTypes: [{ serviceTypeCode: 'OIL-01' }, { serviceTypeCode: 'OIL-01' }] }),
      'user-1',
    );

    const arg = h.tx.serviceOrder.create.mock.calls[0][0];
    expect(arg.data.items.create).toEqual([{ serviceTypeId: 'st-oil', estimateMinutes: 30 }]);
  });

  it('records the new order in status history so it is auditable', async () => {
    const h = build();

    await h.service.register(dto(), 'user-1');

    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'ServiceOrder',
        entityId: 'so1',
        toStatus: 'DRAFT',
        reasonCode: 'WALK_IN_INTAKE',
      }),
    );
  });

  it('captures notification consent, which the walk-in path used to discard', async () => {
    const h = build();

    await h.service.register(dto({ notificationOptInSms: true }), 'user-1');

    expect(h.prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notificationOptInSms: true } }),
    );
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMER_NOTIFICATION_OPTIN',
        reasonCode: 'WALKIN_CAPTURE',
      }),
    );
  });

  it('leaves consent untouched when the staff member did not change it', async () => {
    const h = build();

    await h.service.register(dto({ notificationOptInSms: false }), 'user-1');

    expect(h.prisma.customer.update).not.toHaveBeenCalled();
  });
});
