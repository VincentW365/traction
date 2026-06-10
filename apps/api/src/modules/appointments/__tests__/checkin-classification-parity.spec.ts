import { describe, it, expect, vi } from 'vitest';
import { CheckInService } from '../check-in.service';

/**
 * CR-2026-008 check-in parity: when staff set/change the operational serviceClass
 * at check-in, the same audit + status trail as the classification queue is written.
 * ($transaction is mocked to return a canned result, so the in-tx classification
 *  upsert body isn't executed here; we assert the post-tx audit/status parity.)
 */
function buildCheckIn(opts: { priorServiceClass?: string | null } = {}) {
  const appt = {
    id: 'appt1',
    status: 'CONFIRMED',
    serviceVisit: null,
    customerId: 'c1',
    vehicleId: 'v1',
    siteId: 's1',
    services: [{ serviceType: { requiresMileage: false } }],
    customer: {},
    vehicle: { serviceClass: opts.priorServiceClass ?? null, weightClass: null },
    site: { code: 'BERT-01', timezone: 'America/Jamaica' },
  };
  const prisma: any = {
    appointment: { findUnique: vi.fn(async () => appt) },
    serviceVisit: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async () => ({
      serviceVisit: { id: 'sv1' },
      queueTicket: { ticketNumber: 'A001' },
      statusToken: 'tok',
    })),
  };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new CheckInService(prisma as any, statusHistory as any, audit as any);
  return { service, audit, statusHistory };
}

describe('check-in classification parity (CR-2026-008)', () => {
  it('writes VEHICLE_CLASSIFIED audit + Vehicle status history when serviceClass is set', async () => {
    const h = buildCheckIn({ priorServiceClass: null });

    await h.service.checkIn('appt1', 'u1', undefined, undefined, {
      vehicleServiceClass: 'SEDAN_CLASS',
      vehicleWeightClass: 'LIGHT',
    });

    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'VEHICLE_CLASSIFIED',
        entityType: 'Vehicle',
        entityId: 'v1',
        afterJson: { serviceClass: 'SEDAN_CLASS', weightClass: 'LIGHT' },
        notes: 'Set at check-in',
      }),
    );
    expect(h.statusHistory.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Vehicle', entityId: 'v1', toStatus: 'SEDAN_CLASS' }),
    );
  });

  it('does NOT write a classification audit when serviceClass is not provided', async () => {
    const h = buildCheckIn();

    await h.service.checkIn('appt1', 'u1', undefined, undefined, {});

    const classifiedCalls = h.audit.log.mock.calls.filter(
      (c: any[]) => c[0]?.action === 'VEHICLE_CLASSIFIED',
    );
    expect(classifiedCalls.length).toBe(0);
    // The Vehicle-entity status history is also not written for classification.
    const vehicleStatus = h.statusHistory.record.mock.calls.filter(
      (c: any[]) => c[0]?.entityType === 'Vehicle',
    );
    expect(vehicleStatus.length).toBe(0);
  });
});
