import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { PublicBookingService } from '../public-booking.service';
import { ETA_DEFAULTS } from '../../scheduling/eta/eta.config';
import { hashManageToken } from '../booking-reference';

/**
 * CR-2026-105c — the public booking service with pure Prisma mocks: privacy of
 * identification, the locked confirm path (new customer + vehicle, slot taken,
 * concurrent claim, same-vehicle conflict, reference + hashed token, audit with a
 * null actor, opt-in gated notifications), manage-link cancel/reschedule rules,
 * and the anonymous rate limit.
 */

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

const SITE = { id: 'site-1', code: 'BERT-01', name: "Bert's — Main", timezone: 'America/Jamaica', ticketCode: 'B01' };
const HOURS = { schedule: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '08:00', close: '17:00' }])) };
const MIN = 60_000;

/** A slot tomorrow at 10:00 Jamaica (15:00Z) — always inside hours, past min notice, inside the window. */
function tomorrowAt15Z(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(15, 0, 0, 0);
  return d;
}

interface Opts {
  bookingRules?: Array<{ ruleKey: string; valueJson: unknown; siteId?: string | null }>;
  capacity?: number;
  existingInTx?: Array<{ scheduledStartAt: Date; scheduledEndAt: Date | null }>[]; // per findMany call
  vehicleConflict?: { appointmentNumber: string; scheduledStartAt: Date } | null;
  identifyVehicle?: unknown;
  manageAppt?: unknown;
  rescheduleCount?: number;
}

function build(o: Opts = {}) {
  const txFindManyQueue = [...(o.existingInTx ?? [[]])];
  const created: unknown[] = [];
  const tx: any = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('').includes('daily_booking_counters') ? [{ last_sequence: 3 }] : [{ next_val: 42 }],
    ),
    appointment: {
      findMany: vi.fn(async () => txFindManyQueue.shift() ?? []),
      findFirst: vi.fn(async () => o.vehicleConflict ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: 'appt-1',
          ...data,
          scheduledEndAt: data.scheduledEndAt,
          services: [{ serviceType: { id: 'st-1', code: 'OIL-01', name: 'Oil Change', baseDurationMinutes: 30 } }],
          customer: { id: data.customerId, firstName: 'Jane', phone: '876-555-0100', email: 'jane@example.com', notificationOptInSms: true, notificationOptInEmail: false },
          vehicle: { id: data.vehicleId, plateNumber: 'ABC1234', make: 'Toyota', model: 'Corolla', modelYear: 2019 },
        };
        created.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }: any) => ({ ...(o.manageAppt as object), ...data })),
    },
    customer: { create: vi.fn(async () => ({ id: 'cust-new' })) },
    vehicle: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({ id: 'veh-1' })),
      create: vi.fn(async () => ({ id: 'veh-new' })),
    },
  };
  const prisma: any = {
    site: { findFirst: vi.fn(async () => SITE), findUnique: vi.fn(async () => SITE) },
    businessRuleConfig: {
      findMany: vi.fn(async () => o.bookingRules ?? []),
      findFirst: vi.fn(async ({ where }: any) => (where?.ruleKey === 'operating_hours' ? { valueJson: HOURS } : null)),
    },
    serviceType: { findMany: vi.fn(async () => [{ id: 'st-1', code: 'OIL-01', name: 'Oil Change', baseDurationMinutes: 30 }]) },
    vehicle: { findUnique: vi.fn(async () => o.identifyVehicle ?? null) },
    appointment: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => o.manageAppt ?? null),
      update: vi.fn(async ({ data }: any) => ({ ...(o.manageAppt as object), ...data })),
    },
    statusHistory: { count: vi.fn(async () => o.rescheduleCount ?? 0) },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const eta = { loadRules: vi.fn(async () => ({ ...ETA_DEFAULTS, capacity: o.capacity ?? 2 })) };
  const notifications = { queueAppointmentMessage: vi.fn(async () => undefined) };
  const audit = { log: vi.fn(async () => ({})) };
  const statusHistory = { record: vi.fn(async () => ({})) };
  const service = new PublicBookingService(prisma, eta as any, notifications as any, audit as any, statusHistory as any);
  return { service, prisma, tx, eta, notifications, audit, statusHistory, created };
}

const newBooking = (start: Date) => ({
  customer: { firstName: 'Jane', lastName: 'Doe', phone: '876-555-0100', email: 'jane@example.com', smsOptIn: true, emailOptIn: false },
  vehicle: { plateNumber: 'ABC 1234', make: 'Toyota', model: 'Corolla', modelYear: 2019 },
  serviceCodes: ['OIL-01'],
  scheduledStartAt: start.toISOString(),
});

describe('identify — privacy', () => {
  it('unknown plate → known:false, nothing else', async () => {
    const h = build();
    expect(await h.service.identify({ phone: '876-555-0100', plateNumber: 'ABC1234' }, 'ip1')).toEqual({ known: false });
  });

  it('plate known but phone does not match → known:false (no hint which half was wrong)', async () => {
    const h = build({ identifyVehicle: { id: 'v1', customer: { id: 'c1', firstName: 'Jane', phone: '876-555-9999', vehicles: [] } } });
    expect(await h.service.identify({ phone: '876-555-0100', plateNumber: 'ABC1234' }, 'ip1')).toEqual({ known: false });
  });

  it('both match → session token + masked vehicles, never full plate/phone', async () => {
    const h = build({
      identifyVehicle: {
        id: 'v1',
        customer: {
          id: 'c1', firstName: 'Jane', phone: '(876) 555-0100',
          vehicles: [{ id: 'v1', plateNumber: 'ABC1234', make: 'Toyota', model: 'Corolla', modelYear: 2019 }, { id: 'v2', plateNumber: 'XYZ9', make: null, model: null, modelYear: null }],
        },
      },
    });
    const res = await h.service.identify({ phone: '8765550100', plateNumber: 'abc-1234' }, 'ip1');
    expect(res.known).toBe(true);
    if (!res.known) return;
    expect(JSON.stringify(res)).not.toContain('ABC1234');
    expect(JSON.stringify(res)).not.toContain('5550100');
    expect(res.vehicles?.[0]).toMatchObject({ plateMasked: '***1234', matched: true });
    expect(res.phoneMasked).toBe('••• 0100');
    const payload = jwt.verify(res.sessionToken!, SECRET) as { sub: string; kind: string };
    expect(payload).toMatchObject({ sub: 'c1', kind: 'booking-session' });
  });

  it('rate-limits anonymous callers per route', async () => {
    const h = build();
    for (let i = 0; i < 10; i++) await h.service.identify({ phone: '1', plateNumber: 'X' }, 'ip-rl');
    await expect(h.service.identify({ phone: '1', plateNumber: 'X' }, 'ip-rl')).rejects.toMatchObject({ status: 429 });
  });
});

describe('confirm — the locked reservation', () => {
  it('new customer + new vehicle: creates both, a CONFIRMED self-service appointment with reference + hashed token, audits with a null actor, notifies per opt-in', async () => {
    const h = build();
    const start = tomorrowAt15Z();
    const res = await h.service.confirm(newBooking(start), 'ip1');

    expect(h.tx.$executeRaw).toHaveBeenCalled(); // advisory lock taken
    expect(h.tx.customer.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerNumber: 'CUST-000042', notificationOptInEmail: false }) }));
    expect(h.tx.vehicle.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ vehicleCode: 'SCABC1234', plateNumber: 'ABC 1234' }) }));
    const data = (h.tx.appointment.create.mock.calls as any[])[0][0].data;
    expect(data).toMatchObject({ status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', sourceChannel: 'CUSTOMER_SELF_SERVICE', createdByUserId: null });
    expect(data.appointmentNumber).toMatch(/^BK-B01-\d{6}-003$/);
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(80 * MIN); // management's 80, not the 30-min catalogue
    expect(data.manageTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.manageTokenHash).toBe(hashManageToken(res.manageToken)); // raw token never stored
    expect(res.managePath).toBe(`/book/manage/${res.manageToken}`);
    expect(res.vehicle.plateMasked).toBe('***1234');

    expect(h.statusHistory.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'Appointment', fromStatus: null, toStatus: 'CONFIRMED' }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, action: 'APPOINTMENT_CREATED_ONLINE' }));
    expect(h.notifications.queueAppointmentMessage).toHaveBeenCalledWith('CONFIRMED', expect.objectContaining({ phone: '876-555-0100', email: null, reference: data.appointmentNumber }));
  });

  it('CATALOGUE duration source uses the booked service length', async () => {
    const h = build({ bookingRules: [{ ruleKey: 'appointment_duration_source', valueJson: 'CATALOGUE', siteId: 'site-1' }] });
    await h.service.confirm(newBooking(tomorrowAt15Z()), 'ip1');
    const data = (h.tx.appointment.create.mock.calls as any[])[0][0].data;
    expect(data.scheduledEndAt.getTime() - data.scheduledStartAt.getTime()).toBe(30 * MIN);
  });

  it('slot taken (capacity full inside the lock) → 409 SLOT_TAKEN, nothing created', async () => {
    const start = tomorrowAt15Z();
    const h = build({ capacity: 1, existingInTx: [[{ scheduledStartAt: start, scheduledEndAt: new Date(start.getTime() + 80 * MIN) }]] });
    await expect(h.service.confirm(newBooking(start), 'ip1')).rejects.toMatchObject({ response: { code: 'SLOT_TAKEN' } });
    expect(h.tx.appointment.create).not.toHaveBeenCalled();
    expect(h.tx.customer.create).not.toHaveBeenCalled();
  });

  it('concurrent claim: the second customer sees the first booking under the lock and gets 409', async () => {
    const start = tomorrowAt15Z();
    const h = build({ capacity: 1, existingInTx: [[], [{ scheduledStartAt: start, scheduledEndAt: new Date(start.getTime() + 80 * MIN) }]] });
    await h.service.confirm(newBooking(start), 'ip-a');
    await expect(h.service.confirm(newBooking(start), 'ip-b')).rejects.toMatchObject({ response: { code: 'SLOT_TAKEN' } });
    expect(h.tx.appointment.create).toHaveBeenCalledTimes(1);
  });

  it('same vehicle already booked that day → 409 ALREADY_BOOKED with the existing reference (never a silent merge)', async () => {
    const start = tomorrowAt15Z();
    const h = build({ vehicleConflict: { appointmentNumber: 'BK-B01-260912-001', scheduledStartAt: start } });
    await expect(h.service.confirm(newBooking(start), 'ip1')).rejects.toMatchObject({ response: { code: 'ALREADY_BOOKED', appointmentNumber: 'BK-B01-260912-001' } });
    expect(h.tx.appointment.create).not.toHaveBeenCalled();
  });

  it('plate on another customer → 409 PLATE_IN_USE (no linking)', async () => {
    const h = build();
    h.tx.vehicle.findUnique = vi.fn(async () => ({ id: 'veh-other', customerId: 'someone-else' }));
    await expect(h.service.confirm(newBooking(tomorrowAt15Z()), 'ip1')).rejects.toMatchObject({ response: { code: 'PLATE_IN_USE' } });
  });

  it('rejects too little notice, a closed date, and a time outside hours', async () => {
    const soon = new Date(Date.now() + 30 * MIN);
    await expect(build().service.confirm(newBooking(soon), 'ip1')).rejects.toMatchObject({ status: 400 });
    const start = tomorrowAt15Z();
    const key = start.toISOString().slice(0, 10);
    const closed = build({ bookingRules: [{ ruleKey: 'booking_closed_dates', valueJson: [key], siteId: 'site-1' }] });
    await expect(closed.service.confirm(newBooking(start), 'ip1')).rejects.toMatchObject({ status: 400 });
    const night = new Date(start);
    night.setUTCHours(2, 0, 0, 0); // 21:00 local previous evening
    night.setUTCDate(night.getUTCDate() + 1);
    await expect(build().service.confirm(newBooking(night), 'ip1')).rejects.toMatchObject({ status: 400 });
  });

  it('existing customer via session token books one of their own vehicles', async () => {
    const h = build();
    const sessionToken = jwt.sign({ sub: 'c1', kind: 'booking-session' }, SECRET, { expiresIn: '30m' });
    await h.service.confirm({ sessionToken, vehicleId: '11111111-1111-4111-8111-111111111111', serviceCodes: ['OIL-01'], scheduledStartAt: tomorrowAt15Z().toISOString() }, 'ip1');
    expect(h.tx.customer.create).not.toHaveBeenCalled();
    expect(h.tx.vehicle.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: '11111111-1111-4111-8111-111111111111', customerId: 'c1' } }));
    expect((h.tx.appointment.create.mock.calls as any[])[0][0].data.customerId).toBe('c1');
  });

  it('a forged/expired session token is refused', async () => {
    const h = build();
    const bad = jwt.sign({ sub: 'c1', kind: 'booking-session' }, 'wrong-secret');
    await expect(h.service.confirm({ sessionToken: bad, vehicleId: '11111111-1111-4111-8111-111111111111', serviceCodes: ['OIL-01'], scheduledStartAt: tomorrowAt15Z().toISOString() }, 'ip1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('manage link — cancel / reschedule rules', () => {
  const appt = (start: Date, status = 'CONFIRMED') => ({
    id: 'appt-1', siteId: 'site-1', vehicleId: 'veh-1', status, appointmentNumber: 'BK-B01-260912-001',
    scheduledStartAt: start, scheduledEndAt: new Date(start.getTime() + 80 * MIN),
    services: [{ serviceType: { id: 'st-1', code: 'OIL-01', name: 'Oil Change', baseDurationMinutes: 30 } }],
    customer: { id: 'c1', firstName: 'Jane', phone: '876-555-0100', email: null, notificationOptInSms: true, notificationOptInEmail: true },
    vehicle: { id: 'veh-1', plateNumber: 'ABC1234', make: 'Toyota', model: 'Corolla', modelYear: 2019 },
  });

  it('looks the appointment up by the HASH of the token and returns a masked view with the rule flags', async () => {
    const h = build({ manageAppt: appt(tomorrowAt15Z()) });
    const v = await h.service.manageWithHistory('raw-token');
    expect(h.prisma.appointment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ manageTokenHash: hashManageToken('raw-token') }) }));
    expect(v).toMatchObject({ canCancel: true, canReschedule: true, reschedulesUsed: 0, maxReschedules: 3 });
    expect(v.vehicle.plateMasked).toBe('***1234');
    expect(JSON.stringify(v)).not.toContain('876-555');
  });

  it('cancel inside the cutoff is refused; before it, releases the slot with history + audit + notice', async () => {
    const soon = new Date(Date.now() + 60 * MIN); // cutoff is 2 h
    const blocked = build({ manageAppt: appt(soon) });
    await expect(blocked.service.cancelByCustomer('t', undefined, 'ip1')).rejects.toMatchObject({ response: { code: 'CANNOT_CANCEL' } });

    const ok = build({ manageAppt: appt(tomorrowAt15Z()) });
    const v = await ok.service.cancelByCustomer('t', 'change of plans', 'ip1');
    expect(v.status).toBe('CANCELLED');
    expect(ok.statusHistory.record).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'CANCELLED', reasonCode: 'APPOINTMENT_CANCEL' }));
    expect(ok.audit.log).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, action: 'APPOINTMENT_CANCELLED_BY_CUSTOMER' }));
    expect(ok.notifications.queueAppointmentMessage).toHaveBeenCalledWith('CANCELLED', expect.anything());
  });

  it('reschedule is refused once the maximum is used, otherwise re-checks capacity and moves the slot', async () => {
    const start = tomorrowAt15Z();
    const maxed = build({ manageAppt: appt(start), rescheduleCount: 3 });
    await expect(maxed.service.rescheduleByCustomer('t', { scheduledStartAt: new Date(start.getTime() + 60 * MIN).toISOString() }, 'ip1')).rejects.toMatchObject({ response: { code: 'CANNOT_RESCHEDULE' } });

    const ok = build({ manageAppt: appt(start) });
    const newStart = new Date(start.getTime() + 120 * MIN);
    await ok.service.rescheduleByCustomer('t', { scheduledStartAt: newStart.toISOString() }, 'ip1');
    expect(ok.tx.$executeRaw).toHaveBeenCalled();
    expect(ok.tx.appointment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scheduledStartAt: newStart, status: 'RESCHEDULED', confirmationStatus: 'CONFIRMED' }) }));
    expect(ok.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'APPOINTMENT_RESCHEDULED_BY_CUSTOMER', actorUserId: null }));
    expect(ok.notifications.queueAppointmentMessage).toHaveBeenCalledWith('RESCHEDULED', expect.anything());
  });

  it('a checked-in appointment cannot be changed online', async () => {
    const h = build({ manageAppt: appt(tomorrowAt15Z(), 'CHECKED_IN') });
    const v = await h.service.manageWithHistory('t');
    expect(v.canCancel).toBe(false);
    expect(v.canReschedule).toBe(false);
  });
});
