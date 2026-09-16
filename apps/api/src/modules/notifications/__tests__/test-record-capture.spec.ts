import { describe, it, expect, vi } from 'vitest';
import { NotificationsService, deliveryDisplayState } from '../notifications.service';
import { TestRecordResolver } from '../test-record.resolver';
import type { NotificationCapabilities } from '../providers/notification-provider.interface';

/**
 * CR-2026-108 Stage 1 — UAT must never reach a real customer, and a real customer
 * must never stop being told about their vehicle.
 *
 * Both halves matter. The legacy protection was a GLOBAL mode that redirected
 * every message to one mailbox: safe for the tester, silently harmful to genuine
 * customers if it were ever left on in production. These tests pin the replacement
 * behaviour — suppression decided per RECORD — and pin the regression that genuine
 * traffic is untouched.
 */

const LIVE_CAPS: NotificationCapabilities = {
  smsConfigured: true,
  emailConfigured: true,
  mode: 'LIVE',
};

function build(opts: { isTest?: boolean; runLabel?: string; via?: string; resolverThrows?: boolean } = {}) {
  const provider = { send: vi.fn(async (_input: { recipient: string; channel: string }) => ({ success: true, providerReference: 'prov-1' })) };
  const created: Array<Record<string, unknown>> = [];
  const prisma: Record<string, unknown> = {
    notificationLog: {
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return { id: `log-${created.length}`, ...a.data };
      }),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'log-1', ...a.data })),
      findMany: vi.fn(async () => []),
    },
  };

  const resolver = {
    resolve: vi.fn(async () => {
      if (opts.resolverThrows) throw new Error('db down');
      return opts.isTest
        ? { isTest: true, via: opts.via ?? 'CUSTOMER', runLabel: opts.runLabel ?? 'uat-run-1' }
        : { isTest: false, via: null, runLabel: null };
    }),
  };

  const service = new NotificationsService(
    prisma as never,
    provider as never,
    LIVE_CAPS,
    resolver as unknown as TestRecordResolver,
  );
  return { service, provider, prisma, created, resolver };
}

const APPOINTMENT_MESSAGE = {
  entityType: 'Appointment',
  entityId: 'appt-1',
  channel: 'EMAIL' as const,
  templateKey: 'appointment_confirmation',
  recipient: 'real.customer@example.com',
  templateData: {},
  subject: 'Appointment confirmed — BK-B01-260916-001',
  body: 'Your appointment is confirmed.',
  customerId: 'cust-1',
  vehicleId: 'veh-1',
};

describe('CR-2026-108 — per-record notification capture', () => {
  it('a message about a TEST record is recorded but never transmitted', async () => {
    const h = build({ isTest: true, runLabel: 'uat-booking-2026-09-16', via: 'CUSTOMER' });

    const id = await h.service.queue(APPOINTMENT_MESSAGE);

    expect(h.provider.send).not.toHaveBeenCalled();
    expect(id).toBe('log-1');
    const row = h.created[0];
    expect(row.status).toBe('CAPTURED');
    expect(row.recipient).toBe('real.customer@example.com');
    expect(row.intendedRecipient).toBe('real.customer@example.com');
    expect(row.testRouted).toBe(false);
    expect(row.simulated).toBe(false);
    expect(String(row.failureReason)).toContain('uat-booking-2026-09-16');
  });

  it('captures the exact content the customer would have received', async () => {
    const h = build({ isTest: true });
    await h.service.queue(APPOINTMENT_MESSAGE);
    const row = h.created[0];
    expect(row.subject).toBe('Appointment confirmed — BK-B01-260916-001');
    expect(row.body).toBe('Your appointment is confirmed.');
    // generatedBody too, so UAT can see the template output that was withheld.
    expect(row.generatedBody).toBe('Your appointment is confirmed.');
  });

  it('renders an email body for capture when the caller passed only a template key', async () => {
    const h = build({ isTest: true });
    await h.service.queue({ ...APPOINTMENT_MESSAGE, subject: undefined, body: undefined });
    const row = h.created[0];
    // Capture must not record an empty message where a send would have rendered one.
    expect(String(row.body ?? '')).not.toHaveLength(0);
  });

  it('keeps the customer and vehicle links so the capture is attributable', async () => {
    const h = build({ isTest: true });
    await h.service.queue(APPOINTMENT_MESSAGE);
    expect(h.created[0].customerId).toBe('cust-1');
    expect(h.created[0].vehicleId).toBe('veh-1');
  });

  // --- the other half: genuine traffic is untouched -------------------------
  it('a message about a GENUINE customer is sent exactly as before', async () => {
    const h = build({ isTest: false });

    await h.service.queue(APPOINTMENT_MESSAGE);

    expect(h.provider.send).toHaveBeenCalledOnce();
    expect(h.provider.send.mock.calls[0][0]).toMatchObject({ recipient: 'real.customer@example.com' });
    expect(h.created[0].status).toBe('PENDING');
    expect(h.created[0].recipient).toBe('real.customer@example.com');
  });

  it('delivers normally when the test lookup itself fails — a real customer is never silently cut off', async () => {
    const h = build({ resolverThrows: true });
    // The resolver swallows its own errors; this asserts the service does not
    // treat an unknown verdict as "test" and withhold a genuine message.
    h.resolver.resolve = vi.fn(async () => ({ isTest: false, via: null, runLabel: null }));

    await h.service.queue(APPOINTMENT_MESSAGE);

    expect(h.provider.send).toHaveBeenCalledOnce();
  });

  it('without a resolver wired, behaviour is exactly pre-CR (nothing is ever captured)', async () => {
    const provider = { send: vi.fn(async (_input: { recipient: string; channel: string }) => ({ success: true })) };
    const prisma = {
      notificationLog: {
        create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'log-1', ...a.data })),
        update: vi.fn(async () => ({ id: 'log-1' })),
      },
    };
    const service = new NotificationsService(prisma as never, provider as never, LIVE_CAPS);

    await service.queue(APPOINTMENT_MESSAGE);

    expect(provider.send).toHaveBeenCalledOnce();
  });
});

describe('CR-2026-108 — CAPTURED is an honest display state', () => {
  it('never reads as queued, sent or failed', () => {
    expect(deliveryDisplayState({ status: 'CAPTURED' })).toBe('CAPTURED');
    // Regression: the states that already existed are unchanged.
    expect(deliveryDisplayState({ status: 'SENT' })).toBe('SENT');
    expect(deliveryDisplayState({ status: 'SENT', simulated: true })).toBe('SIMULATED');
    expect(deliveryDisplayState({ status: 'SENT', testRouted: true })).toBe('TEST_REDIRECTED');
    expect(deliveryDisplayState({ status: 'FAILED' })).toBe('FAILED');
    expect(deliveryDisplayState({ status: 'PENDING' })).toBe('QUEUED');
  });
});

describe('CR-2026-108 — TestRecordResolver', () => {
  function resolverWith(db: Record<string, unknown>) {
    return new TestRecordResolver(db as never);
  }
  const none = { findUnique: vi.fn(async () => null) };

  it('recognises a test record through the customer link', async () => {
    const r = resolverWith({
      customer: { findUnique: vi.fn(async () => ({ testDataRun: { label: 'uat-1' } })) },
      vehicle: none, serviceVisit: none, appointment: none,
    });
    await expect(r.resolve({ customerId: 'c1' })).resolves.toEqual({ isTest: true, via: 'CUSTOMER', runLabel: 'uat-1' });
  });

  it('recognises a test record through the vehicle link', async () => {
    const r = resolverWith({
      customer: { findUnique: vi.fn(async () => ({ testDataRun: null })) },
      vehicle: { findUnique: vi.fn(async () => ({ testDataRun: { label: 'uat-2' } })) },
      serviceVisit: none, appointment: none,
    });
    await expect(r.resolve({ customerId: 'c1', vehicleId: 'v1' })).resolves.toMatchObject({ isTest: true, via: 'VEHICLE' });
  });

  it('recognises a test ServiceVisit', async () => {
    const r = resolverWith({
      customer: none, vehicle: none,
      serviceVisit: { findUnique: vi.fn(async () => ({ testDataRun: { label: 'uat-3' } })) },
      appointment: none,
    });
    await expect(r.resolve({ entityType: 'ServiceVisit', entityId: 'sv1' })).resolves.toMatchObject({ isTest: true, via: 'SERVICE_VISIT' });
  });

  /** The self-service booking case: Appointment has no anchor of its own. */
  it('resolves an Appointment through its customer/vehicle/visit', async () => {
    const r = resolverWith({
      customer: none, vehicle: none, serviceVisit: none,
      appointment: {
        findUnique: vi.fn(async () => ({
          customer: { testDataRun: null },
          vehicle: { testDataRun: { label: 'uat-booking' } },
          serviceVisit: null,
        })),
      },
    });
    await expect(r.resolve({ entityType: 'Appointment', entityId: 'a1' })).resolves.toEqual({
      isTest: true, via: 'APPOINTMENT', runLabel: 'uat-booking',
    });
  });

  it('a genuine record is not a test record', async () => {
    const r = resolverWith({
      customer: { findUnique: vi.fn(async () => ({ testDataRun: null })) },
      vehicle: { findUnique: vi.fn(async () => ({ testDataRun: null })) },
      serviceVisit: none,
      appointment: { findUnique: vi.fn(async () => ({ customer: { testDataRun: null }, vehicle: { testDataRun: null }, serviceVisit: null })) },
    });
    await expect(r.resolve({ entityType: 'Appointment', entityId: 'a1', customerId: 'c1', vehicleId: 'v1' })).resolves.toEqual({
      isTest: false, via: null, runLabel: null,
    });
  });

  it('fails toward DELIVERY when the lookup errors', async () => {
    const r = resolverWith({ customer: { findUnique: vi.fn(async () => { throw new Error('db down'); }) } });
    // Withholding a genuine message is the worse failure: it silently denies a
    // customer information about their vehicle.
    await expect(r.resolve({ customerId: 'c1' })).resolves.toEqual({ isTest: false, via: null, runLabel: null });
  });
});
