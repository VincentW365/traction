import { describe, it, expect, vi } from 'vitest';
import { AppointmentsService } from '../appointments.service';
import { BookingAvailabilityService } from '../../scheduling/availability/booking-availability.service';
import { ETA_DEFAULTS } from '../../scheduling/eta/eta.config';

/**
 * CR-2026-106 — staff bookings run on the SAME engine as the public page (docs/121 §D
 * "Engine parity"): planned duration from the shared rule (80, not the catalogue sum),
 * the per-day lock taken inside the transaction with capacity re-checked under it,
 * CAPACITY_FULL unless acknowledged (audited), the latest-start rule only when
 * enforced for staff (explicit, audited override), staff availability with the
 * STAFF audience, and customer notification + token revocation when staff change
 * an online booking.
 */

const MIN = 60_000;
const SITE = { id: 'site-1', timezone: 'America/Jamaica', name: "Bert's" };
const HOURS = { schedule: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, { open: '08:00', close: '17:00' }])) };

function dayKeyPlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const at = (key: string, hh: number, mm = 0) => new Date(`${key}T${String(hh + 5).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

function build(o: { rules?: Array<{ ruleKey: string; valueJson: unknown; siteId?: string | null }>; capacity?: number; existingInTx?: Array<{ scheduledStartAt: Date; scheduledEndAt: Date | null }>; existingAppt?: any } = {}) {
  const tx: any = {
    $executeRaw: vi.fn(async () => 1),
    appointment: {
      findMany: vi.fn(async () => o.existingInTx ?? []),
      create: vi.fn(async ({ data }: any) => ({ id: 'appt-1', ...data, services: [], customer: {}, vehicle: {}, site: SITE })),
      update: vi.fn(async ({ data }: any) => ({ ...(o.existingAppt ?? {}), ...data })),
    },
    appointmentService: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  const prisma: any = {
    site: { findUnique: vi.fn(async () => SITE) },
    businessRuleConfig: {
      findMany: vi.fn(async ({ where }: any) => (where?.ruleKey?.in ? (o.rules ?? []) : [])),
      findFirst: vi.fn(async ({ where }: any) => (where?.ruleKey === 'operating_hours' ? { valueJson: HOURS } : null)),
    },
    serviceType: { findMany: vi.fn(async () => [{ id: 'st-1', code: 'OIL-01', name: 'Oil Change', baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null }]) },
    appointment: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => o.existingAppt ?? null),
      update: vi.fn(async ({ data }: any) => ({ ...(o.existingAppt ?? {}), ...data })),
    },
    $transaction: vi.fn(async (cb: any) => cb(tx)),
  };
  const eta = { loadRules: vi.fn(async () => ({ ...ETA_DEFAULTS, capacity: o.capacity ?? 2 })) };
  const availability = new BookingAvailabilityService(prisma, eta as any);
  const statusHistory = { record: vi.fn(async () => ({})) };
  const audit = { log: vi.fn(async () => ({})) };
  const notifications = { queueAppointmentMessage: vi.fn(async () => undefined) };
  const service = new AppointmentsService(prisma, statusHistory as any, audit as any, eta as any, availability, notifications as any);
  return { service, prisma, tx, audit, statusHistory, notifications };
}

const key = dayKeyPlus(3);
const dto = (start: Date, extra: Record<string, unknown> = {}) => ({
  siteId: 'site-1',
  customerId: '11111111-1111-1111-1111-111111111111',
  vehicleId: '22222222-2222-2222-2222-222222222222',
  scheduledStartAt: start.toISOString(),
  serviceTypes: [{ serviceTypeCode: 'OIL-01' }],
  ...extra,
});

describe('staff create — same engine', () => {
  it('plans the DEFAULT 80 minutes (not the 30-minute catalogue sum) and takes the day lock inside the transaction', async () => {
    const h = build();
    const start = at(key, 10);
    await h.service.create(dto(start) as any, 'user-1');
    const data = h.tx.appointment.create.mock.calls[0][0].data;
    expect(data.scheduledEndAt.getTime() - start.getTime()).toBe(80 * MIN);
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1); // pg_advisory_xact_lock
  });

  it('CAPACITY_FULL under the lock unless acknowledged; the acknowledgement is audited', async () => {
    const taken = [{ scheduledStartAt: at(key, 10), scheduledEndAt: at(key, 11, 20) }];
    const h = build({ capacity: 1, existingInTx: taken });
    await expect(h.service.create(dto(at(key, 10, 20)) as any, 'user-1')).rejects.toMatchObject({ response: { code: 'CAPACITY_FULL', capacity: 1, booked: 1 } });
    expect(h.tx.appointment.create).not.toHaveBeenCalled();
    const ok = build({ capacity: 1, existingInTx: taken });
    await ok.service.create(dto(at(key, 10, 20), { acknowledgeCapacity: true }) as any, 'user-1');
    expect(ok.tx.appointment.create).toHaveBeenCalledTimes(1);
    expect(ok.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'APPOINTMENT_CAPACITY_ACKNOWLEDGED', reasonCode: 'CAPACITY_FULL' }));
  });

  it('staff are NOT held to the 3 PM rule unless staff_latest_start_enforced; then an explicit override is required and audited', async () => {
    const late = at(key, 15, 40);
    const free = build();
    await free.service.create(dto(late) as any, 'user-1');
    expect(free.tx.appointment.create).toHaveBeenCalledTimes(1);
    expect(free.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'APPOINTMENT_LATEST_START_OVERRIDDEN' }));

    const enforced = build({ rules: [{ ruleKey: 'staff_latest_start_enforced', valueJson: true, siteId: 'site-1' }] });
    await expect(enforced.service.create(dto(late) as any, 'user-1')).rejects.toMatchObject({ response: { code: 'AFTER_LATEST_START' } });
    const overridden = build({ rules: [{ ruleKey: 'staff_latest_start_enforced', valueJson: true, siteId: 'site-1' }] });
    await overridden.service.create(dto(late, { overrideLatestStart: true }) as any, 'user-1');
    expect(overridden.tx.appointment.create).toHaveBeenCalledTimes(1);
    expect(overridden.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'APPOINTMENT_LATEST_START_OVERRIDDEN', reasonCode: 'AFTER_LATEST_START' }));
  });
});

describe('staff availability + booking link', () => {
  it('returns STAFF-audience availability from the shared engine (no latest-start label unless enforced)', async () => {
    const h = build();
    const r = await h.service.staffAvailability('site-1', ['OIL-01'], key, 1);
    expect(r.audience).toBe('STAFF');
    expect(r.plannedMinutes).toBe(80);
    expect(r.latestStartLabel).toBeNull();
    expect(r.days[0].date).toBe(key);
    expect(r.days[0].slots.length).toBeGreaterThan(0);
  });

  it('bookingLink builds the URL from the public base and addresses WhatsApp/SMS to the Jamaican mobile', async () => {
    process.env.PUBLIC_APP_URL = 'https://bsop-web.onrender.com';
    const h = build();
    const r = await h.service.bookingLink('site-1', '(876) 555-0106');
    expect(r.bookingUrl).toBe('https://bsop-web.onrender.com/book');
    expect(r.message).toContain('https://bsop-web.onrender.com/book');
    expect(r.message).toContain("Bert's");
    expect(r.whatsappUrl.startsWith('https://wa.me/18765550106?text=')).toBe(true);
    expect(r.smsUrl.startsWith('sms:+18765550106?body=')).toBe(true);
    delete process.env.PUBLIC_APP_URL;
  });
});

describe('staff changes to an ONLINE booking', () => {
  const online = {
    id: 'appt-9',
    siteId: 'site-1',
    vehicleId: '22222222-2222-2222-2222-222222222222',
    status: 'CONFIRMED',
    sourceChannel: 'CUSTOMER_SELF_SERVICE',
    appointmentNumber: 'BK-B01-260918-001',
    manageTokenHash: 'hash',
    scheduledStartAt: at(key, 10),
    scheduledEndAt: at(key, 11, 20),
    services: [{ qty: 1, serviceType: { id: 'st-1', code: 'OIL-01', name: 'Oil Change', baseDurationMinutes: 30, sedanDurationMinutes: null, suvDurationMinutes: null } }],
    customer: { phone: '8765550100', email: 'c@example.com', notificationOptInSms: true, notificationOptInEmail: true },
    vehicle: { plateNumber: 'ABC1234', make: 'Toyota', model: 'Corolla' },
    site: { name: "Bert's", timezone: 'America/Jamaica' },
  };

  it('cancel revokes the manage link at once and tells the customer (audited)', async () => {
    const h = build({ existingAppt: online });
    await h.service.cancel('appt-9', 'Workshop closed', 'user-1');
    const data = h.prisma.appointment.update.mock.calls[0][0].data;
    expect(data.status).toBe('CANCELLED');
    expect(data.manageTokenExpiresAt).toBeInstanceOf(Date);
    expect(h.notifications.queueAppointmentMessage).toHaveBeenCalledWith('CANCELLED', expect.objectContaining({ reference: 'BK-B01-260918-001', vehicle: expect.stringContaining('Toyota Corolla') }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'APPOINTMENT_CANCELLED_BY_STAFF' }));
  });

  it('reschedule re-checks capacity under the lock (excluding itself) and notifies the customer with change guidance', async () => {
    const h = build({ existingAppt: online });
    const newStart = at(key, 13);
    await h.service.update('appt-9', { scheduledStartAt: newStart.toISOString() } as any, 'user-1');
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
    const findManyArgs = h.tx.appointment.findMany.mock.calls[0][0];
    expect(findManyArgs.where.id).toEqual({ not: 'appt-9' });
    expect(h.notifications.queueAppointmentMessage).toHaveBeenCalledWith('RESCHEDULED', expect.objectContaining({ changeGuidance: expect.stringContaining('made by the service centre') }));
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'APPOINTMENT_RESCHEDULED_BY_STAFF' }));
  });

  it('a STAFF booking (not online) is cancelled without a customer message', async () => {
    const h = build({ existingAppt: { ...online, sourceChannel: 'STAFF', manageTokenHash: null } });
    await h.service.cancel('appt-9', 'No show', 'user-1');
    expect(h.notifications.queueAppointmentMessage).not.toHaveBeenCalled();
    expect(h.prisma.appointment.update.mock.calls[0][0].data.manageTokenExpiresAt).toBeUndefined();
  });
});
