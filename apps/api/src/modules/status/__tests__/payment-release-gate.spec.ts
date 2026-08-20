import { describe, it, expect, vi } from 'vitest';
import { ServiceVisitCompletionController } from '../status.controller';

/**
 * CR-2026-085 — GOV-005's vehicle-release payment gate was WITHDRAWN by owner
 * direction. Payment is settled in the external POS, so Traction only ever mirrored
 * a `paymentStatus` field; gating close-out on it stalled the front desk on data
 * this system does not own, and every real release became a manager override — an
 * exception that fires every time is not a control.
 *
 * What must remain true:
 *   - closing a visit is NEVER blocked by payment, for any role;
 *   - payment state is still recorded, and closing with payment uncleared still
 *     leaves an audit trail, so "was this car released before payment cleared?"
 *     stays answerable after the fact.
 *
 * These tests exist to stop the gate being reintroduced by accident. Bringing it
 * back is a business-rule decision (docs/03_Business_Rules.md, GOV-005), not a
 * code tweak.
 */
function build(orderPaymentStatuses: string[]) {
  const visit = {
    id: 'sv1',
    mileageIn: null,
    vehicleId: 'v1',
    appointment: null,
    serviceOrders: orderPaymentStatuses.map((paymentStatus, i) => ({
      id: `so${i}`,
      paymentStatus,
      items: [{ serviceType: { requiresMileage: false } }],
    })),
  };
  const tx = {
    serviceVisit: { update: vi.fn(async () => ({ id: 'sv1' })) },
    vehicle: { update: vi.fn(async () => ({})) },
    resourceOccupancy: { updateMany: vi.fn(async () => ({ count: 0 })) },
    // CR-2026-084 — closing a visit also closes its queue ticket, which this path
    // previously left reading IN_SERVICE forever.
    queueTicket: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma: any = {
    serviceVisit: { findUnique: vi.fn(async () => visit) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const audit = { log: vi.fn(async () => ({})) };
  const controller = new ServiceVisitCompletionController(prisma as any, audit as any);
  return { controller, prisma, audit, tx };
}

const user = (role: string) => ({ sub: 'u1', role, siteId: 's1', permissions: [] }) as any;
const closed = expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED' }) });

describe('vehicle release is no longer gated on payment (GOV-005 withdrawn)', () => {
  it('closes an unpaid visit without any override', async () => {
    const h = build(['UNPAID']);

    const res = await h.controller.recordCompletion('sv1', {}, user('ADMIN'));

    expect(h.tx.serviceVisit.update).toHaveBeenCalledWith(closed);
    expect(res).toMatchObject({ serviceVisitId: 'sv1' });
  });

  it('lets a service advisor close an unpaid visit — no manager needed', async () => {
    const h = build(['PENDING']);

    await h.controller.recordCompletion('sv1', {}, user('SERVICE_ADVISOR'));

    expect(h.tx.serviceVisit.update).toHaveBeenCalledWith(closed);
  });

  it('still audits the release when payment was not cleared', async () => {
    const h = build(['UNPAID', 'PAID']);

    await h.controller.recordCompletion('sv1', {}, user('SERVICE_ADVISOR'));

    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYMENT_RELEASE_OVERRIDE',
        entityType: 'ServiceVisit',
        entityId: 'sv1',
        reasonCode: 'RELEASED_PAYMENT_NOT_CLEARED',
        afterJson: expect.objectContaining({ gateEnforced: false }),
      }),
    );
    // Only the genuinely uncleared order is named.
    const logged = (h.audit.log.mock.calls[0] as unknown as any[])[0];
    expect(logged.beforeJson.unpaidOrders).toHaveLength(1);
    expect(logged.beforeJson.unpaidOrders[0]).toMatchObject({ paymentStatus: 'UNPAID' });
  });

  it('keeps a supplied reason on the audit row when one is given', async () => {
    const h = build(['UNPAID']);

    await h.controller.recordCompletion(
      'sv1',
      { paymentReleaseOverrideReason: 'Account customer, invoice mailed' },
      user('ADMIN'),
    );

    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'Account customer, invoice mailed' }),
    );
  });

  it('writes no payment audit row when every order is cleared', async () => {
    const h = build(['PAID', 'WAIVED', 'ON_ACCOUNT']);

    await h.controller.recordCompletion('sv1', {}, user('SERVICE_ADVISOR'));

    expect(h.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_RELEASE_OVERRIDE' }),
    );
    expect(h.tx.serviceVisit.update).toHaveBeenCalledWith(closed);
  });

  it('closes a visit that has no orders at all', async () => {
    const h = build([]);

    await h.controller.recordCompletion('sv1', {}, user('SERVICE_ADVISOR'));

    expect(h.tx.serviceVisit.update).toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('still rejects a mileage-out reading below mileage-in (a data error, not a policy)', async () => {
    const h = build(['PAID']);
    (h.prisma.serviceVisit.findUnique as any).mockResolvedValueOnce({
      id: 'sv1', mileageIn: 50000, vehicleId: 'v1', appointment: null, serviceOrders: [],
    });

    await expect(
      h.controller.recordCompletion('sv1', { mileageOut: 49000 }, user('ADMIN')),
    ).rejects.toThrow(/mileage/i);
  });
});
