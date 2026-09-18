import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { PublicBookingService, normaliseServiceRequest } from '../public-booking.service';
import { ETA_DEFAULTS } from '../../scheduling/eta/eta.config';

/**
 * CR-2026-111 §16 — the customer's booking becomes the Job Sheet's intake.
 *
 * These are management's four scenarios at the point where the booking is written:
 * an existing customer booking General Servicing (including the approved 90/120
 * class split), an existing customer booking a Battery service, a new customer
 * describing a problem under "Other", and the fact that nothing a customer types
 * is ever treated as a diagnosis.
 *
 * The other half of the journey — the same facts arriving on the Job Sheet without
 * anyone retyping them — is proved in
 * `appointments/__tests__/cr-2026-111-job-sheet-prefill.spec.ts`.
 */

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

const SITE = { id: 'site-1', code: 'BERT-01', name: "Bert's — Main", timezone: 'America/Jamaica', ticketCode: 'B01' };
const HOURS = { schedule: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '08:00', close: '17:00' }])) };
const MIN = 60_000;

/** The approved customer catalogue, with the durations management signed off. */
const CATALOGUE = {
  'GEN-SERV-01': { id: 'st-gen', code: 'GEN-SERV-01', name: 'General Servicing', customerFacingName: 'General Servicing', baseDurationMinutes: 90, sedanDurationMinutes: 90, suvDurationMinutes: 120 },
  'BAT-01': { id: 'st-bat', code: 'BAT-01', name: 'Battery Test / Replacement', customerFacingName: 'Battery Service', baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null },
  'ASSESS-01': { id: 'st-ass', code: 'ASSESS-01', name: 'Vehicle Assessment', customerFacingName: 'Vehicle Assessment', baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null },
  'OIL-01': { id: 'st-oil', code: 'OIL-01', name: 'Oil Change', customerFacingName: 'Oil Change', baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null },
} as const;

/** Tomorrow at 10:00 Jamaica — inside hours, past min notice, inside the window. */
function tomorrowAt15Z(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(15, 0, 0, 0);
  return d;
}

interface Opts {
  /** Durations only mean something under CATALOGUE; see the DEFAULT test below. */
  durationSource?: 'CATALOGUE' | 'DEFAULT';
  /** What `vehicles.serviceClass` says for the vehicle being booked. */
  serviceClass?: 'SEDAN_CLASS' | 'SUV_CLASS' | null;
}

function build(o: Opts = {}) {
  const tx: any = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('').includes('daily_booking_counters') ? [{ last_sequence: 0 }] : [{ next_val: 7 }],
    ),
    appointment: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({
        id: 'appt-1',
        ...data,
        services: [{ serviceType: CATALOGUE['OIL-01'] }],
        customer: { id: data.customerId, firstName: 'Jane', phone: '876-555-0100', email: null, notificationOptInSms: true, notificationOptInEmail: false },
        vehicle: { id: data.vehicleId, plateNumber: 'ABC1234', make: 'Toyota', model: 'RAV4', modelYear: 2021 },
      })),
      update: vi.fn(async ({ data }: any) => data),
    },
    customer: { create: vi.fn(async () => ({ id: 'cust-new' })), findFirst: vi.fn(async () => null) },
    vehicle: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({ id: 'veh-1' })), // ownership check passes
      create: vi.fn(async () => ({ id: 'veh-new' })),
    },
  };
  const prisma: any = {
    site: { findFirst: vi.fn(async () => SITE), findUnique: vi.fn(async () => SITE) },
    businessRuleConfig: {
      findMany: vi.fn(async () => [{ ruleKey: 'appointment_duration_source', valueJson: o.durationSource ?? 'CATALOGUE', siteId: 'site-1' }]),
      findFirst: vi.fn(async ({ where }: any) => (where?.ruleKey === 'operating_hours' ? { valueJson: HOURS } : null)),
    },
    serviceType: {
      findMany: vi.fn(async ({ where }: any) => {
        const codes: string[] = where?.code?.in ?? [];
        return codes.map((c) => (CATALOGUE as Record<string, unknown>)[c]).filter(Boolean);
      }),
    },
    // What `vehicleClassOf` reads. `serviceClass: undefined` would mean "column not
    // selected"; these tests always answer explicitly.
    vehicle: { findUnique: vi.fn(async () => ({ serviceClass: o.serviceClass ?? null })) },
    appointment: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    statusHistory: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const eta = { loadRules: vi.fn(async () => ({ ...ETA_DEFAULTS, capacity: 4 })) };
  const notifications = { queueAppointmentMessage: vi.fn(async () => undefined) };
  const audit = { log: vi.fn(async () => ({})) };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const service = new PublicBookingService(prisma, eta as any, notifications as any, audit as any, statusHistory as any);
  return { service, prisma, tx, service_: service };
}

const sessionFor = (customerId: string) => jwt.sign({ sub: customerId, kind: 'booking-session' }, SECRET, { expiresIn: '1h' });

/** What the six-step page posts for an existing customer. */
function existingCustomerBooking(over: Record<string, unknown> = {}) {
  return {
    sessionToken: sessionFor('cust-1'),
    vehicleId: '11111111-1111-4111-8111-111111111111',
    serviceCodes: ['GEN-SERV-01'],
    scheduledStartAt: tomorrowAt15Z().toISOString(),
    ...over,
  } as any;
}

const createdAppointment = (h: ReturnType<typeof build>) => (h.tx.appointment.create.mock.calls as any[])[0][0].data;

// ---------------------------------------------------------------------------
// Scenario 1 — existing customer, General Servicing
// ---------------------------------------------------------------------------

describe('§16.1 existing customer books General Servicing', () => {
  it('an SUV on file is planned at the approved 120 minutes, not the 90-minute base', async () => {
    const h = build({ serviceClass: 'SUV_CLASS' });
    await h.service.confirm(existingCustomerBooking(), 'ip1');
    const data = createdAppointment(h);
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(120 * MIN);
  });

  it('a sedan on file is planned at 90', async () => {
    const h = build({ serviceClass: 'SEDAN_CLASS' });
    await h.service.confirm(existingCustomerBooking(), 'ip1');
    const data = createdAppointment(h);
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(90 * MIN);
  });

  /**
   * CR-2026-111b §5 — an unclassified vehicle gets the LONGER standard, not the
   * shorter one.
   *
   * This reverses the first cut, which fell back to the base (sedan) figure. The
   * two errors are not symmetrical: over-planning costs a little capacity, while
   * under-planning holds a bay past the slot and into the next customer's
   * appointment. Missing classification data must not be resolved in the
   * shop's favour.
   */
  it('a vehicle with no class recorded gets the CONSERVATIVE 120, never the shorter 90', async () => {
    const h = build({ serviceClass: null });
    await h.service.confirm(existingCustomerBooking(), 'ip1');
    const data = createdAppointment(h);
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(120 * MIN);
  });

  /**
   * The class is read from the VEHICLE RECORD. A public caller cannot assert
   * "sedan" in the request and buy a shorter slot than the work needs.
   */
  it('the class comes from the vehicle record, never from the request body', async () => {
    const h = build({ serviceClass: 'SUV_CLASS' });
    await h.service.confirm(existingCustomerBooking({ vehicleClass: 'SEDAN_CLASS', serviceRequest: { vehicleClass: 'SEDAN_CLASS' } }), 'ip1');
    const data = createdAppointment(h);
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(120 * MIN);
    expect(h.prisma.vehicle.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: { serviceClass: true } }),
    );
  });

  it("carries the customer's mileage, concern and chosen card onto the appointment", async () => {
    const h = build({ serviceClass: 'SEDAN_CLASS' });
    await h.service.confirm(
      existingCustomerBooking({
        serviceRequest: {
          reasonForVisit: 'General Servicing',
          concern: 'Due for its 90,000 km service and the aircon smells musty.',
          mileage: 89_940,
          category: 'GENERAL_SERVICING',
        },
      }),
      'ip1',
    );
    const data = createdAppointment(h);
    expect(data.customerReportedMileage).toBe(89_940);
    expect(data.bookingIntake.create).toMatchObject({
      category: 'GENERAL_SERVICING',
      customerConcern: 'Due for its 90,000 km service and the aircon smells musty.',
      sourceChannel: 'CUSTOMER_SELF_SERVICE',
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — existing customer, Battery
// ---------------------------------------------------------------------------

describe('§16.2 existing customer books a Battery service', () => {
  it('books BAT-01 and keeps the ticked symptoms as intake', async () => {
    const h = build({ serviceClass: 'SEDAN_CLASS' });
    await h.service.confirm(
      existingCustomerBooking({
        serviceCodes: ['BAT-01'],
        serviceRequest: {
          reasonForVisit: 'Battery Test / Replacement',
          concern: 'It struggles to start first thing in the morning.',
          category: 'BATTERY',
          symptoms: ['BATTERY_SLOW_START', 'BATTERY_REPEATEDLY_FLAT'],
          mileage: 51_200,
        },
      }),
      'ip1',
    );
    const data = createdAppointment(h);
    expect(data.services.create).toEqual([expect.objectContaining({ serviceTypeId: 'st-bat' })]);
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(30 * MIN);
    expect(data.bookingIntake.create).toMatchObject({
      category: 'BATTERY',
      symptoms: ['BATTERY_SLOW_START', 'BATTERY_REPEATEDLY_FLAT'],
    });
  });

  /** A battery has no sedan/SUV split, so the class must not alter its length. */
  it('a service with no class split is the same length for any vehicle', async () => {
    for (const serviceClass of ['SEDAN_CLASS', 'SUV_CLASS', null] as const) {
      const h = build({ serviceClass });
      await h.service.confirm(existingCustomerBooking({ serviceCodes: ['BAT-01'] }), 'ip1');
      const data = createdAppointment(h);
      expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime(), String(serviceClass)).toBe(30 * MIN);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — new customer, "Other / describe my issue"
// ---------------------------------------------------------------------------

describe('§16.3 new customer describes a problem under Other', () => {
  const newCustomerOther = () => ({
    customer: { firstName: 'Marcus', lastName: 'Chen', phone: '876-555-0188', smsOptIn: true, emailOptIn: false },
    vehicle: { plateNumber: 'XYZ 9911', make: 'Honda', model: 'CR-V', modelYear: 2017 },
    serviceCodes: ['ASSESS-01'],
    scheduledStartAt: tomorrowAt15Z().toISOString(),
    serviceRequest: {
      reasonForVisit: 'Other / Describe My Issue',
      concern: 'There is a rattling sound under the car when I go over a bump, and it smells like burning after a long drive.',
      category: 'OTHER',
      mileage: 132_450,
    },
  }) as any;

  it('books the assessment service — never a repair chosen on the customer\'s behalf', async () => {
    const h = build();
    await h.service.confirm(newCustomerOther(), 'ip1');
    const data = createdAppointment(h);
    expect(data.services.create).toEqual([expect.objectContaining({ serviceTypeId: 'st-ass' })]);
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(30 * MIN);
  });

  /**
   * ASSESS-01 exists precisely so an assessment is NOT booked as General Servicing.
   * Reusing a general-service code would measure a 30-minute look-over against the
   * 90-minute general-service benchmark and report the shop as far ahead of standard.
   */
  it('does not book, or resemble, a General Service', async () => {
    const h = build();
    await h.service.confirm(newCustomerOther(), 'ip1');
    const data = createdAppointment(h);
    const booked = data.services.create.map((s: { serviceTypeId: string }) => s.serviceTypeId);
    expect(booked).not.toContain('st-gen');
    expect(booked).not.toContain('st-oil');
  });

  it("keeps the customer's sentence verbatim — not trimmed to a category label", async () => {
    const h = build();
    const dto = newCustomerOther();
    await h.service.confirm(dto, 'ip1');
    const data = createdAppointment(h);
    expect(data.bookingIntake.create.customerConcern).toBe(dto.serviceRequest.concern);
    expect(data.bookingIntake.create.category).toBe('OTHER');
    // The words survive on the appointment notes as well, for staff who read those.
    expect(data.notes).toContain('rattling sound under the car');
  });

  it('creates the customer and the vehicle in the same transaction as the booking', async () => {
    const h = build();
    await h.service.confirm(newCustomerOther(), 'ip1');
    expect(h.tx.customer.create).toHaveBeenCalled();
    expect(h.tx.vehicle.create).toHaveBeenCalled();
    expect(h.tx.appointment.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The configuration that decides whether any of the durations above apply
// ---------------------------------------------------------------------------

/**
 * A standing caveat, written as a test so it cannot quietly stop being true.
 *
 * `appointment_duration_source` is the switch. Under CATALOGUE the approved
 * per-service figures apply, including the 90/120 split. Under DEFAULT every online
 * booking is the flat default length and the catalogue durations — approved or not —
 * change nothing. The site currently runs DEFAULT, so switching it is a business
 * decision with shop-wide effect, not a side effect of this change.
 */
describe('the duration source governs whether the approved figures apply', () => {
  it('under DEFAULT, the vehicle class changes nothing', async () => {
    for (const serviceClass of ['SEDAN_CLASS', 'SUV_CLASS'] as const) {
      const h = build({ durationSource: 'DEFAULT', serviceClass });
      await h.service.confirm(existingCustomerBooking(), 'ip1');
      const data = createdAppointment(h);
      expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime(), serviceClass).toBe(
        ETA_DEFAULTS.defaultDurationMinutes * MIN,
      );
    }
  });

  it('under CATALOGUE, it does', async () => {
    const h = build({ durationSource: 'CATALOGUE', serviceClass: 'SUV_CLASS' });
    await h.service.confirm(existingCustomerBooking(), 'ip1');
    const data = createdAppointment(h);
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(120 * MIN);
  });
});

// ---------------------------------------------------------------------------
// The intake shape itself (pure)
// ---------------------------------------------------------------------------

describe('normaliseServiceRequest — what reaches the Job Sheet', () => {
  it("prefers the customer's own sentence over the card they tapped", () => {
    const r = normaliseServiceRequest({ reasonForVisit: 'Brake Service / Inspection', concern: 'Grinding noise when I brake downhill.', category: 'BRAKES' });
    expect(r.intake?.customerConcern).toBe('Grinding noise when I brake downhill.');
  });

  it('falls back to the card label when they wrote nothing', () => {
    const r = normaliseServiceRequest({ reasonForVisit: 'Oil Change', category: 'OIL_CHANGE' });
    expect(r.intake?.customerConcern).toBe('Oil Change');
  });

  it('normalises and de-duplicates symptom codes', () => {
    const r = normaliseServiceRequest({ category: 'BRAKES', symptoms: [' brake_noise ', 'BRAKE_NOISE', 'brake_vibration', ''] });
    expect(r.intake?.symptoms).toEqual(['BRAKE_NOISE', 'BRAKE_VIBRATION']);
  });

  it('caps nothing and invents nothing when the customer said nothing at all', () => {
    const r = normaliseServiceRequest(undefined);
    expect(r).toMatchObject({ notes: null, mileage: null, intake: null, view: null });
  });

  it('a negative or absurd mileage is dropped rather than stored', () => {
    expect(normaliseServiceRequest({ mileage: -5 }).mileage).toBeNull();
    expect(normaliseServiceRequest({ mileage: Number.NaN }).mileage).toBeNull();
    expect(normaliseServiceRequest({ mileage: 84_500.6 }).mileage).toBe(84_501);
  });
});
