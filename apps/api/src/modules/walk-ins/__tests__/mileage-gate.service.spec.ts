import { describe, it, expect, vi } from 'vitest';
import { WalkInsService } from '../walk-ins.service';

/**
 * DMAIC Rule 5 at the walk-in intake boundary — shared assertMileageGate (matches
 * check-in + completion). Mocks pass validations up to the gate.
 */
function build(requiresMileage: boolean) {
  const prisma: any = {
    site: { findUnique: vi.fn(async () => ({ id: 's1', code: 'BERT-01', timezone: 'America/Jamaica', isActive: true })) },
    customer: { findUnique: vi.fn(async () => ({ id: 'c1', firstName: 'A', lastName: 'B', phone: 'x' })) },
    vehicle: { findUnique: vi.fn(async () => ({ id: 'v1', customerId: 'c1', plateNumber: 'P', make: 'M', model: 'Mo', modelYear: 2015 })), update: vi.fn(async () => ({})) },
    serviceType: { findMany: vi.fn(async () => [{ id: 'st1', code: 'OIL-01', baseDurationMinutes: 30, requiresMileage }]) },
    serviceVisit: { findFirst: vi.fn(async () => null) },
    // canned tx → callback (ticket generation etc.) never executes
    $transaction: vi.fn(async () => ({ serviceVisit: { id: 'sv1' }, queueTicket: { ticketNumber: 'A001' }, statusToken: 'tok' })),
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new WalkInsService(prisma as any, statusHistory as any, audit as any);
  return { service, audit };
}
const dto = (over: Record<string, unknown> = {}) => ({
  siteId: 's1', customerId: 'c1', vehicleId: 'v1', serviceTypes: [{ serviceTypeCode: 'OIL-01' }], ...over,
}) as any;

describe('Rule 5 @ walk-in intake', () => {
  it('service-category walk-in requires mileage → rejects when none provided', async () => {
    const h = build(true);
    await expect(h.service.register(dto({}), 'u1')).rejects.toThrow(/required/i);
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('non-service walk-in → rejects when mileage is provided', async () => {
    const h = build(false);
    await expect(h.service.register(dto({ mileageIn: 1000 }), 'u1')).rejects.toThrow(/non-service/i);
  });

  it('manager override (with reason) → allowed AND audited', async () => {
    const h = build(false);
    await expect(
      h.service.register(dto({ mileageIn: 1000, mileageOverride: true, overrideReason: 'mgr ok' }), 'u1'),
    ).resolves.toBeDefined();
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MILEAGE_GATE_OVERRIDE', notes: 'mgr ok', actorUserId: 'u1' }),
    );
  });

  it('override WITHOUT a reason → rejected', async () => {
    const h = build(false);
    await expect(
      h.service.register(dto({ mileageIn: 1000, mileageOverride: true }), 'u1'),
    ).rejects.toThrow(/override reason/i);
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('no regression: valid service walk-in (mileage provided) creates the visit', async () => {
    const h = build(true);
    await expect(h.service.register(dto({ mileageIn: 5000 }), 'u1')).resolves.toMatchObject({
      queueTicket: { ticketNumber: 'A001' },
    });
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('no regression: valid non-service walk-in (no mileage) creates the visit', async () => {
    const h = build(false);
    await expect(h.service.register(dto({}), 'u1')).resolves.toBeDefined();
    expect(h.audit.log).not.toHaveBeenCalled();
  });
});
