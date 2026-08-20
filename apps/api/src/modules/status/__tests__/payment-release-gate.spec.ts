import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ServiceVisitCompletionController } from '../status.controller';

/**
 * P4(c) — vehicle-release payment gate (GOV-005). Releasing a visit (status →
 * CLOSED) is blocked unless every order's payment is cleared (PAID/ON_ACCOUNT/
 * WAIVED) or a MANAGER/ADMIN records an audited exception with a reason.
 * No schema change — exception lives in AuditLog. Mocked PrismaService.
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
    // CR-2026-084 — closing a visit now also closes its queue ticket, which this
    // path previously left reading IN_SERVICE forever.
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

describe('P4(c) vehicle-release payment gate', () => {
  it('blocks release when an order is unpaid and no override is given', async () => {
    const h = build(['UNPAID']);
    await expect(h.controller.recordCompletion('sv1', {}, user('ADMIN'))).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('blocks an override attempted by a non-manager', async () => {
    const h = build(['PENDING']);
    await expect(
      h.controller.recordCompletion('sv1', { paymentReleaseOverride: true, paymentReleaseOverrideReason: 'ok' }, user('SERVICE_ADVISOR')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires a reason for a manager override', async () => {
    const h = build(['UNPAID']);
    await expect(
      h.controller.recordCompletion('sv1', { paymentReleaseOverride: true }, user('ADMIN')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a manager override with a reason and audits it', async () => {
    const h = build(['UNPAID']);
    const res = await h.controller.recordCompletion(
      'sv1',
      { paymentReleaseOverride: true, paymentReleaseOverrideReason: 'Account customer, invoice mailed' },
      user('ADMIN'),
    );
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYMENT_RELEASE_OVERRIDE',
        entityType: 'ServiceVisit',
        entityId: 'sv1',
        reasonCode: 'PAYMENT_RELEASE_OVERRIDE',
        notes: 'Account customer, invoice mailed',
      }),
    );
    expect(h.tx.serviceVisit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED' }) }),
    );
    expect(res).toMatchObject({ serviceVisitId: 'sv1' });
  });

  it('allows release with no override when all orders are cleared', async () => {
    const h = build(['PAID', 'WAIVED', 'ON_ACCOUNT']);
    await h.controller.recordCompletion('sv1', {}, user('FRONT_DESK'));
    expect(h.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_RELEASE_OVERRIDE' }));
    expect(h.tx.serviceVisit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED' }) }),
    );
  });

  it('allows release when the visit has no orders (nothing to clear)', async () => {
    const h = build([]);
    await h.controller.recordCompletion('sv1', {}, user('FRONT_DESK'));
    expect(h.tx.serviceVisit.update).toHaveBeenCalled();
  });
});
