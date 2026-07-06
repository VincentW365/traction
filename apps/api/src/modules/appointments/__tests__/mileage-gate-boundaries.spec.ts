import { describe, it, expect, vi } from 'vitest';
import { CheckInService } from '../check-in.service';
import { ServiceVisitCompletionController } from '../../status/status.controller';

/**
 * DMAIC Rule 5 — mileage gate at CHECK-IN (mileageIn) still enforced.
 * At COMPLETION (mileageOut) mileage is now OPTIONAL always (CR-2026-072) — no gate;
 * a provided value must still be >= mileage in.
 */

// ---------------------------------------------------------------------------
// Boundary 1: check-in mileageIn
// ---------------------------------------------------------------------------
function buildCheckIn(requiresMileage: boolean) {
  const appt = {
    id: 'appt1',
    status: 'CONFIRMED',
    serviceVisit: null,
    customerId: 'c1',
    vehicleId: 'v1',
    siteId: 's1',
    services: [{ serviceType: { requiresMileage } }],
    customer: {},
    vehicle: {},
    site: { code: 'BERT-01', timezone: 'America/Jamaica' },
  };
  const prisma: any = {
    appointment: { findUnique: vi.fn(async () => appt) },
    serviceVisit: { findFirst: vi.fn(async () => null) }, // no duplicate
    // returned canned so the post-gate transaction body is never executed
    $transaction: vi.fn(async () => ({
      serviceVisit: { id: 'sv1' },
      queueTicket: { ticketNumber: 'A001' },
      statusToken: 'tok',
    })),
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new CheckInService(prisma as any, statusHistory as any, audit as any);
  return { service, audit };
}

describe('Rule 5 @ check-in (mileageIn)', () => {
  it('service job requires mileage → rejects when none provided', async () => {
    const h = buildCheckIn(true);
    await expect(
      h.service.checkIn('appt1', 'u1', undefined, undefined, {}),
    ).rejects.toThrow(/required/i);
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('non-service job → ALLOWS mileage (CR-2026-037 — mileage decoupled from service)', async () => {
    const h = buildCheckIn(false);
    await expect(
      h.service.checkIn('appt1', 'u1', undefined, undefined, { mileageIn: 1000 }),
    ).resolves.toBeDefined();
  });

  it('manager override → allows non-service mileage AND audits it', async () => {
    const h = buildCheckIn(false);
    await expect(
      h.service.checkIn('appt1', 'u1', undefined, undefined, {
        mileageIn: 1000,
        mileageOverride: true,
        overrideReason: 'mgr ok',
      }),
    ).resolves.toBeDefined();
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MILEAGE_GATE_OVERRIDE', notes: 'mgr ok' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary 2: completion mileageOut
// ---------------------------------------------------------------------------
function buildCompletion(requiresMileage: boolean) {
  const visit = {
    id: 'sv1',
    mileageIn: null,
    vehicleId: 'v1',
    appointment: { services: [{ serviceType: { requiresMileage } }] },
    serviceOrders: [],
  };
  const prisma: any = {
    serviceVisit: { findUnique: vi.fn(async () => visit) },
    vehicle: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => ({ id: 'sv1' })),
  };
  const audit = { log: vi.fn(async () => ({})) };
  const controller = new ServiceVisitCompletionController(prisma as any, audit as any);
  return { controller, audit };
}

describe('completion (mileageOut) — optional always (CR-2026-072)', () => {
  const user = { sub: 'u1' } as any;

  it('does NOT require mileage — completes with no mileageOut even for a service job', async () => {
    const h = buildCompletion(true);
    await expect(h.controller.recordCompletion('sv1', {}, user)).resolves.toBeDefined();
  });

  it('accepts an optional mileageOut', async () => {
    const h = buildCompletion(false);
    await expect(
      h.controller.recordCompletion('sv1', { mileageOut: 1000 }, user),
    ).resolves.toBeDefined();
  });

  it('accepts optional completion notes', async () => {
    const h = buildCompletion(false);
    await expect(
      h.controller.recordCompletion('sv1', { notes: 'all good' }, user),
    ).resolves.toBeDefined();
  });
});
