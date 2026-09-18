import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { AppointmentsService } from '../../../appointments/appointments.service';
import { PublicBookingService } from '../../../public-booking/public-booking.service';
import { BookingAvailabilityService } from '../booking-availability.service';
import {
  catalogueMinutesFor,
  resolveAppointmentDuration,
  SERVICE_DURATION_SELECT,
  variesByVehicleClass,
  type MeasurableService,
} from '../service-duration';
import { ETA_DEFAULTS } from '../../eta/eta.config';
import { resolvePlannedMinutes } from '../../eta/eta.model';

/**
 * CR-2026-111b §12 — the two defects, made permanently impossible.
 *
 *   DEFECT A — a service with vehicle-class durations selected WITHOUT those
 *     columns. The duration silently collapsed to the base figure, so every SUV
 *     was planned at the sedan length and the feature looked complete while doing
 *     nothing.
 *
 *   DEFECT B — a reschedule that reloaded only `baseDurationMinutes` and lost the
 *     class duration, shrinking an SUV general service from 120 minutes to 90 the
 *     moment anybody moved the appointment.
 *
 * And the rule those defects broke: the same vehicle and the same service resolve
 * to the SAME planned duration on all four paths — customer create, customer
 * reschedule, staff create, staff reschedule (§4). These tests drive the real
 * services through the real shared engine, not a stub of it; a stubbed engine
 * would prove only that the stub agrees with itself.
 */

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

const MIN = 60_000;
const SITE = { id: 'site-1', code: 'BERT-01', name: "Bert's — Main", timezone: 'America/Jamaica', ticketCode: 'B01' };
const HOURS = { schedule: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '08:00', close: '17:00' }])) };

/** The approved General Servicing standard: 90 sedan, 120 SUV. */
const GEN_SERV: MeasurableService & { id: string; code: string; name: string } = {
  id: 'st-gen',
  code: 'GEN-SERV-01',
  name: 'General Servicing',
  baseDurationMinutes: 90,
  sedanDurationMinutes: 90,
  suvDurationMinutes: 120,
};
/** A service that takes the same time on everything. */
const OIL: MeasurableService & { id: string; code: string; name: string } = {
  id: 'st-oil',
  code: 'OIL-01',
  name: 'Oil Change',
  baseDurationMinutes: 30,
  sedanDurationMinutes: null,
  suvDurationMinutes: null,
};

const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

function dayKeyPlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const KEY = dayKeyPlus(3);
/** Site-local hour → UTC (Jamaica is UTC-5, no DST). */
const at = (hh: number) => new Date(`${KEY}T${String(hh + 5).padStart(2, '0')}:00:00Z`);

type Cls = 'SEDAN_CLASS' | 'SUV_CLASS' | null;

/** Keep only the keys a Prisma `select` asked for, as Prisma itself would. */
function project<T extends Record<string, unknown>>(row: T, select: Record<string, unknown> | undefined): Partial<T> {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k as keyof T]]),
  ) as Partial<T>;
}

/**
 * Apply an appointment `include` to the fixture the way Prisma would.
 *
 * Without this the mock hands back every column whatever the query asked for, and
 * a regression that drops the class columns from the include is invisible — the
 * test passes while the defect is live. Honouring the select is what makes the
 * Defect B assertions real rather than decorative.
 */
function applyInclude(appt: any, include: any): any {
  const serviceTypeSelect = include?.services?.include?.serviceType?.select;
  if (!serviceTypeSelect) return appt;
  return {
    ...appt,
    services: appt.services.map((s: any) => ({ ...s, serviceType: project(s.serviceType, serviceTypeSelect) })),
  };
}

/**
 * One mocked database, two real services, one real shared engine.
 *
 * Both channels read the same `serviceType` rows and the same `vehicle` row, so a
 * divergence between them can only come from the code under test.
 */
function build(o: { serviceClass: Cls; durationSource?: 'CATALOGUE' | 'DEFAULT'; existingServices?: typeof GEN_SERV[] } = { serviceClass: null }) {
  const durationSource = o.durationSource ?? 'CATALOGUE';
  const existingServices = o.existingServices ?? [GEN_SERV];

  /** The appointment a reschedule moves. Prisma's `serviceType: true` loads every column. */
  const existingAppt: any = {
    id: 'appt-existing',
    siteId: SITE.id,
    customerId: CUSTOMER_ID,
    vehicleId: VEHICLE_ID,
    status: 'CONFIRMED',
    sourceChannel: 'STAFF',
    scheduledStartAt: at(9),
    scheduledEndAt: at(11),
    services: existingServices.map((s) => ({ qty: 1, serviceType: { ...s } })),
    customer: { id: CUSTOMER_ID, firstName: 'Jane', phone: '876-555-0100', email: null, notificationOptInSms: false, notificationOptInEmail: false },
    vehicle: { id: VEHICLE_ID, plateNumber: 'ABC1234', make: 'Toyota', model: 'RAV4', modelYear: 2021 },
    site: SITE,
  };

  const tx: any = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('').includes('daily_booking_counters') ? [{ last_sequence: 0 }] : [{ next_val: 9 }],
    ),
    appointment: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => existingAppt),
      create: vi.fn(async ({ data, include }: any) => ({
        id: 'appt-new',
        ...data,
        services: applyInclude(existingAppt, include).services,
        customer: existingAppt.customer,
        vehicle: existingAppt.vehicle,
        site: SITE,
      })),
      update: vi.fn(async ({ data }: any) => ({ ...existingAppt, ...data })),
    },
    appointmentService: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    customer: { create: vi.fn(async () => ({ id: CUSTOMER_ID })), findFirst: vi.fn(async () => null) },
    vehicle: {
      findUnique: vi.fn(async () => ({ serviceClass: o.serviceClass })),
      findFirst: vi.fn(async () => ({ id: VEHICLE_ID })),
      create: vi.fn(async () => ({ id: VEHICLE_ID })),
    },
    statusHistory: { create: vi.fn(async () => ({})) },
  };

  const prisma: any = {
    site: { findFirst: vi.fn(async () => SITE), findUnique: vi.fn(async () => SITE) },
    businessRuleConfig: {
      findMany: vi.fn(async ({ where }: any) =>
        where?.ruleKey?.in ? [{ ruleKey: 'appointment_duration_source', valueJson: durationSource, siteId: SITE.id }] : [],
      ),
      findFirst: vi.fn(async ({ where }: any) => (where?.ruleKey === 'operating_hours' ? { valueJson: HOURS } : null)),
    },
    serviceType: {
      findMany: vi.fn(async ({ where, select }: any) => {
        // The mock honours the SELECT, exactly as Prisma would. A query that omits
        // the class columns therefore gets rows without them — which is how
        // Defect A can be reproduced here rather than merely asserted about.
        const wanted: string[] = where?.code?.in ?? [GEN_SERV.code];
        const rows = [GEN_SERV, OIL].filter((s) => wanted.includes(s.code));
        if (!select) return rows.map((r) => ({ ...r }));
        return rows.map((r) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, (r as any)[k]])));
      }),
    },
    // Both channels read the class from the SAME row.
    vehicle: { findUnique: vi.fn(async () => ({ serviceClass: o.serviceClass })) },
    appointment: {
      findMany: vi.fn(async () => []),
      // The manage-link lookup finds the appointment; every other findFirst (the
      // same-vehicle-same-day conflict check) must find nothing.
      findFirst: vi.fn(async ({ where, include }: any) => (where?.manageTokenHash ? applyInclude(existingAppt, include) : null)),
      findUnique: vi.fn(async ({ include }: any) => applyInclude(existingAppt, include)),
      update: vi.fn(async ({ data }: any) => ({ ...existingAppt, ...data })),
    },
    statusHistory: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };

  const eta = { loadRules: vi.fn(async () => ({ ...ETA_DEFAULTS, capacity: 6 })) };
  const availability = new BookingAvailabilityService(prisma, eta as any);
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const notifications = { queueAppointmentMessage: vi.fn(async () => undefined) };

  const staff = new AppointmentsService(prisma, statusHistory as any, audit as any, eta as any, availability, notifications as any);
  const customer = new PublicBookingService(prisma, eta as any, notifications as any, audit as any, statusHistory as any, availability);

  return { staff, customer, prisma, tx, availability, existingAppt };
}

const minutesOf = (data: { scheduledStartAt: Date; scheduledEndAt: Date }) =>
  Math.round((data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()) / MIN);

// ---------------------------------------------------------------------------
// The four paths must agree
// ---------------------------------------------------------------------------

/** Staff create → the minutes written to the appointment. */
async function staffCreateMinutes(h: ReturnType<typeof build>, codes = ['GEN-SERV-01']): Promise<number> {
  await h.staff.create(
    {
      siteId: SITE.id,
      customerId: CUSTOMER_ID,
      vehicleId: VEHICLE_ID,
      scheduledStartAt: at(9).toISOString(),
      serviceTypes: codes.map((c) => ({ serviceTypeCode: c })),
    } as any,
    'user-1',
  );
  return minutesOf((h.tx.appointment.create.mock.calls as any[])[0][0].data);
}

/** Staff reschedule → the minutes written by the update. */
async function staffRescheduleMinutes(h: ReturnType<typeof build>): Promise<number> {
  await h.staff.update('appt-existing', { scheduledStartAt: at(13).toISOString() } as any, 'user-1');
  const call = (h.tx.appointment.update.mock.calls as any[]).find((c) => c[0]?.data?.scheduledEndAt);
  return minutesOf(call[0].data);
}

/** Customer create → the minutes written to the appointment. */
async function customerCreateMinutes(h: ReturnType<typeof build>, codes = ['GEN-SERV-01']): Promise<number> {
  await h.customer.confirm(
    {
      sessionToken: jwt.sign({ sub: CUSTOMER_ID, kind: 'booking-session' }, SECRET, { expiresIn: '1h' }),
      vehicleId: VEHICLE_ID,
      serviceCodes: codes,
      scheduledStartAt: at(9).toISOString(),
    } as any,
    'ip-parity',
  );
  return minutesOf((h.tx.appointment.create.mock.calls as any[])[0][0].data);
}

/** Customer reschedule (manage link) → the minutes written by the update. */
async function customerRescheduleMinutes(h: ReturnType<typeof build>): Promise<number> {
  h.existingAppt.manageTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * MIN);
  h.existingAppt.sourceChannel = 'CUSTOMER_SELF_SERVICE';
  await h.customer.rescheduleByCustomer('a'.repeat(48), { scheduledStartAt: at(13).toISOString() } as any, 'ip-parity');
  const call = (h.tx.appointment.update.mock.calls as any[]).find((c) => c[0]?.data?.scheduledEndAt);
  return minutesOf(call[0].data);
}

describe('§4 the four booking paths resolve the SAME duration', () => {
  it('SUV General Servicing is 120 minutes however the appointment is made', async () => {
    expect(await staffCreateMinutes(build({ serviceClass: 'SUV_CLASS' }))).toBe(120);
    expect(await staffRescheduleMinutes(build({ serviceClass: 'SUV_CLASS' }))).toBe(120);
    expect(await customerCreateMinutes(build({ serviceClass: 'SUV_CLASS' }))).toBe(120);
  });

  it('Sedan General Servicing is 90 minutes however the appointment is made', async () => {
    expect(await staffCreateMinutes(build({ serviceClass: 'SEDAN_CLASS' }))).toBe(90);
    expect(await staffRescheduleMinutes(build({ serviceClass: 'SEDAN_CLASS' }))).toBe(90);
    expect(await customerCreateMinutes(build({ serviceClass: 'SEDAN_CLASS' }))).toBe(90);
  });

  /**
   * This is the divergence that prompted §3: an advisor booking an SUV got 90
   * while the customer booking the identical work got 120. The channel is not an
   * input to how long the work takes.
   */
  it('a staff booking and a customer booking of the same work are never different lengths', async () => {
    for (const serviceClass of ['SEDAN_CLASS', 'SUV_CLASS', null] as const) {
      const staffMinutes = await staffCreateMinutes(build({ serviceClass }));
      const customerMinutes = await customerCreateMinutes(build({ serviceClass }));
      expect(staffMinutes, `class ${serviceClass}`).toBe(customerMinutes);
    }
  });

  it('a service with no class split is the same length for every vehicle and channel', async () => {
    for (const serviceClass of ['SEDAN_CLASS', 'SUV_CLASS', null] as const) {
      expect(await staffCreateMinutes(build({ serviceClass }), ['OIL-01']), `staff ${serviceClass}`).toBe(30);
      expect(await customerCreateMinutes(build({ serviceClass }), ['OIL-01']), `customer ${serviceClass}`).toBe(30);
    }
  });
});

// ---------------------------------------------------------------------------
// Defect B — a reschedule must not change the length
// ---------------------------------------------------------------------------

describe('§12 Defect B — rescheduling does not lose the vehicle-class duration', () => {
  it('an SUV general service still occupies 120 minutes after a staff reschedule', async () => {
    expect(await staffRescheduleMinutes(build({ serviceClass: 'SUV_CLASS' }))).toBe(120);
  });

  it('an SUV general service still occupies 120 minutes after a customer reschedule', async () => {
    expect(await customerRescheduleMinutes(build({ serviceClass: 'SUV_CLASS' }))).toBe(120);
  });

  it('a sedan general service stays 90 after either reschedule', async () => {
    expect(await staffRescheduleMinutes(build({ serviceClass: 'SEDAN_CLASS' }))).toBe(90);
    expect(await customerRescheduleMinutes(build({ serviceClass: 'SEDAN_CLASS' }))).toBe(90);
  });

  it('moving an appointment never changes its length', async () => {
    for (const serviceClass of ['SEDAN_CLASS', 'SUV_CLASS', null] as const) {
      const created = await staffCreateMinutes(build({ serviceClass }));
      const moved = await staffRescheduleMinutes(build({ serviceClass }));
      expect(moved, `class ${serviceClass}`).toBe(created);
    }
  });
});

// ---------------------------------------------------------------------------
// Defect A — the columns must be loaded
// ---------------------------------------------------------------------------

describe('§12 Defect A — a class-split service cannot be measured without its class columns', () => {
  it('throws rather than silently returning the base duration', () => {
    const missing = { baseDurationMinutes: 90, code: 'GEN-SERV-01' } as unknown as MeasurableService;
    expect(() => catalogueMinutesFor(missing, 'SUV_CLASS')).toThrow(/without its vehicle-class duration columns/);
    expect(() =>
      resolveAppointmentDuration({ services: [missing], vehicleClass: 'SUV_CLASS', policy: 'CATALOGUE', defaultMinutes: 80 }),
    ).toThrow(/SERVICE_DURATION_SELECT/);
  });

  it('names the service, so the offending query can be found', () => {
    const missing = { baseDurationMinutes: 90, code: 'GEN-SERV-01' } as unknown as MeasurableService;
    expect(() => catalogueMinutesFor(missing, null)).toThrow(/GEN-SERV-01/);
  });

  /** `null` is a loaded column with no class-specific figure. That is not the defect. */
  it('a genuinely null column is fine — it means "same time for every vehicle"', () => {
    expect(() => catalogueMinutesFor(OIL, 'SUV_CLASS')).not.toThrow();
    expect(catalogueMinutesFor(OIL, 'SUV_CLASS')).toBe(30);
  });

  it('the shared select names every column the resolver requires', () => {
    for (const column of ['baseDurationMinutes', 'sedanDurationMinutes', 'suvDurationMinutes']) {
      expect(SERVICE_DURATION_SELECT, column).toHaveProperty(column, true);
    }
  });

  /**
   * The real queries must use the shared select. A query that hand-lists the
   * columns is how the defect happened the first time, and a hand-listed query
   * that is correct today can silently stop being correct tomorrow.
   */
  it('the staff service-type query loads the class columns from the database', async () => {
    const h = build({ serviceClass: 'SUV_CLASS' });
    await staffCreateMinutes(h);
    const select = (h.prisma.serviceType.findMany.mock.calls as any[])[0][0].select;
    expect(select).toMatchObject({ sedanDurationMinutes: true, suvDurationMinutes: true });
  });

  it('the customer service-type query loads them too', async () => {
    const h = build({ serviceClass: 'SUV_CLASS' });
    await customerCreateMinutes(h);
    const select = (h.prisma.serviceType.findMany.mock.calls as any[])[0][0].select;
    expect(select).toMatchObject({ sedanDurationMinutes: true, suvDurationMinutes: true });
  });
});

// ---------------------------------------------------------------------------
// §5 — unknown class, and §6 — policy separate from duration
// ---------------------------------------------------------------------------

describe('§5 an unknown vehicle class takes the conservative duration', () => {
  it('uses the LONGEST configured figure, never the shorter standard', () => {
    const r = resolveAppointmentDuration({ services: [GEN_SERV], vehicleClass: null, policy: 'CATALOGUE', defaultMinutes: 80 });
    expect(r.plannedMinutes).toBe(120);
    expect(r.classBasis).toBe('UNKNOWN_ASSUMED_LONGEST');
    expect(r.explanation).toContain('vehicle class unknown');
  });

  it('says so, rather than resolving it quietly', () => {
    const known = resolveAppointmentDuration({ services: [GEN_SERV], vehicleClass: 'SUV_CLASS', policy: 'CATALOGUE', defaultMinutes: 80 });
    expect(known.classBasis).toBe('SUV');
    // Same number, different reason — a report must be able to tell them apart.
    expect(known.plannedMinutes).toBe(120);
  });

  it('does not claim an unknown class for a service that charges the same either way', () => {
    const r = resolveAppointmentDuration({ services: [OIL], vehicleClass: null, policy: 'CATALOGUE', defaultMinutes: 80 });
    expect(r.classBasis).toBe('NOT_APPLICABLE');
    expect(r.plannedMinutes).toBe(30);
  });

  it('an unclassified SUV booked by staff or by the customer both get 120', async () => {
    expect(await staffCreateMinutes(build({ serviceClass: null }))).toBe(120);
    expect(await customerCreateMinutes(build({ serviceClass: null }))).toBe(120);
  });
});

describe('§6/§7 the duration policy is separate from the configured duration', () => {
  it('reports the configured duration even while DEFAULT is in force', () => {
    const r = resolveAppointmentDuration({ services: [GEN_SERV], vehicleClass: 'SUV_CLASS', policy: 'DEFAULT', defaultMinutes: 80 });
    expect(r.plannedMinutes).toBe(80);
    expect(r.catalogueMinutes).toBe(120);
    expect(r.policy).toBe('DEFAULT');
  });

  /**
   * §7 — DEFAULT means exactly the flat figure for EVERY service. There is no
   * per-service exception, and this test exists so one cannot be added quietly.
   */
  it('DEFAULT is the flat figure for every service, with no per-service escape hatch', () => {
    for (const service of [GEN_SERV, OIL]) {
      for (const vehicleClass of ['SEDAN_CLASS', 'SUV_CLASS', null] as const) {
        const r = resolveAppointmentDuration({ services: [service], vehicleClass, policy: 'DEFAULT', defaultMinutes: 80 });
        expect(r.plannedMinutes, `${service.code}/${vehicleClass}`).toBe(80);
      }
    }
  });

  it('names the shortfall when the policy plans less than the work needs', () => {
    const suv = resolveAppointmentDuration({ services: [GEN_SERV], vehicleClass: 'SUV_CLASS', policy: 'DEFAULT', defaultMinutes: 80 });
    expect(suv.underPlannedByMinutes).toBe(40);
    expect(suv.explanation).toContain('SHORT of the 120-minute configured duration');

    const sedan = resolveAppointmentDuration({ services: [GEN_SERV], vehicleClass: 'SEDAN_CLASS', policy: 'DEFAULT', defaultMinutes: 80 });
    expect(sedan.underPlannedByMinutes).toBe(10);
  });

  it('reports no shortfall when the flat default is longer than the work', () => {
    const r = resolveAppointmentDuration({ services: [OIL], vehicleClass: null, policy: 'DEFAULT', defaultMinutes: 80 });
    expect(r.underPlannedByMinutes).toBe(0);
    expect(r.catalogueMinutes).toBe(30);
  });

  it('under CATALOGUE the configured duration is what is planned', () => {
    const r = resolveAppointmentDuration({ services: [GEN_SERV], vehicleClass: 'SUV_CLASS', policy: 'CATALOGUE', defaultMinutes: 80 });
    expect(r.plannedMinutes).toBe(120);
    expect(r.underPlannedByMinutes).toBe(0);
  });

  it('several services add up', () => {
    const r = resolveAppointmentDuration({ services: [GEN_SERV, OIL], vehicleClass: 'SUV_CLASS', policy: 'CATALOGUE', defaultMinutes: 80 });
    expect(r.catalogueMinutes).toBe(150);
  });

  it('falls back to the default when nothing is configured at all', () => {
    const unconfigured: MeasurableService = { baseDurationMinutes: null, sedanDurationMinutes: null, suvDurationMinutes: null };
    const r = resolveAppointmentDuration({ services: [unconfigured], vehicleClass: null, policy: 'CATALOGUE', defaultMinutes: 80 });
    expect(r.plannedMinutes).toBe(80);
  });
});

/**
 * §3 — the queue ETA is a duration path too.
 *
 * A vehicle that has checked in but has no service order yet is projected from its
 * BOOKED services. That branch summed `baseDurationMinutes` and knew nothing about
 * the vehicle, so a waiting SUV general service was projected at 90 minutes — wrong
 * for that customer, and wrong for everyone behind them in the queue.
 */
describe('§3 the queue ETA uses the same class rule', () => {
  const booked = (qty = 1) => [{ ...GEN_SERV, qty }];

  it('projects an SUV general service at 120 minutes', () => {
    expect(resolvePlannedMinutes({ appointmentServices: booked(), vehicleClass: 'SUV_CLASS' }, 80)).toBe(120);
  });

  it('projects a sedan general service at 90', () => {
    expect(resolvePlannedMinutes({ appointmentServices: booked(), vehicleClass: 'SEDAN_CLASS' }, 80)).toBe(90);
  });

  it('projects an unclassified vehicle conservatively, like every other path', () => {
    expect(resolvePlannedMinutes({ appointmentServices: booked(), vehicleClass: null }, 80)).toBe(120);
  });

  it('still multiplies by quantity', () => {
    expect(resolvePlannedMinutes({ appointmentServices: booked(2), vehicleClass: 'SUV_CLASS' }, 80)).toBe(240);
  });

  /** A fixed KPI standard already accounts for the class, and still wins. */
  it('never overrides a KPI standard already fixed for the job', () => {
    expect(resolvePlannedMinutes({ kpiStandardMinutes: 75, appointmentServices: booked(), vehicleClass: 'SUV_CLASS' }, 80)).toBe(75);
  });

  it('refuses to guess from a booked service loaded without its class columns', () => {
    const missing = [{ baseDurationMinutes: 90, code: 'GEN-SERV-01', qty: 1 }] as never;
    expect(() => resolvePlannedMinutes({ appointmentServices: missing, vehicleClass: 'SUV_CLASS' }, 80)).toThrow(
      /vehicle-class duration columns/,
    );
  });
});

describe('variesByVehicleClass', () => {
  it('is true only for a service with a class-specific figure', () => {
    expect(variesByVehicleClass(GEN_SERV)).toBe(true);
    expect(variesByVehicleClass(OIL)).toBe(false);
    expect(variesByVehicleClass({ sedanDurationMinutes: null, suvDurationMinutes: 120 })).toBe(true);
    expect(variesByVehicleClass({ sedanDurationMinutes: 0, suvDurationMinutes: 0 })).toBe(false);
  });

  /** Used to skip a vehicle lookup whose result could not change the answer. */
  it('lets the staff path avoid a pointless vehicle query', async () => {
    const h = build({ serviceClass: 'SUV_CLASS' });
    await staffCreateMinutes(h, ['OIL-01']);
    expect(h.prisma.vehicle.findUnique).not.toHaveBeenCalled();

    const h2 = build({ serviceClass: 'SUV_CLASS' });
    await staffCreateMinutes(h2, ['GEN-SERV-01']);
    expect(h2.prisma.vehicle.findUnique).toHaveBeenCalled();
  });
});
