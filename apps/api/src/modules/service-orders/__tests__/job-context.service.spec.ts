import { describe, it, expect, vi } from 'vitest';
import { ServiceOrdersService } from '../service-orders.service';

/**
 * CR-2026-101 — the technician's read-only job context + vehicle history.
 * One read answers: what vehicle, what does the customer want, what is
 * authorized, where am I working, is anything blocking, how long should it take.
 */

function build(prismaOverrides: any = {}) {
  const prisma: any = {
    serviceOrder: { findUnique: vi.fn() },
    vehicleInspection: { findMany: vi.fn(async () => []) },
    serviceVisit: { findMany: vi.fn(async () => []) },
    serviceOrderPause: { findMany: vi.fn(async () => []) },
    ...prismaOverrides,
  };
  const service = new ServiceOrdersService(
    prisma as any,
    { record: vi.fn(async () => ({})) } as any,
    { log: vi.fn(async () => ({})) } as any,
    { recomputeQueue: vi.fn(async () => ({})) } as any,
    {} as any,
    {} as any,
  );
  return { service, prisma };
}

const contextOrder = {
  id: 'so-1',
  status: 'ASSIGNED',
  startedAt: null,
  completedAt: null,
  promisedCompletionAt: null,
  notes: 'Customer will wait on site',
  items: [
    { id: 'i1', serviceType: { id: 'st1', code: 'OIL-01', name: 'Oil Change', baseDurationMinutes: 30 } },
    { id: 'i2', serviceType: { id: 'st2', code: 'BRK-01', name: 'Brake Job', baseDurationMinutes: 60 } },
  ],
  assignments: [
    {
      id: 'ta-1',
      isPrimary: true,
      startedAt: null,
      bay: { code: 'B2', bayType: 'GENERAL' },
      technician: { id: 't1', employeeCode: 'T-01', userAccount: { fullName: 'Bob Smith' } },
    },
  ],
  pauses: [],
  reworks: [],
  serviceVisit: {
    id: 'sv-1',
    visitNumber: 'B01-260901-004',
    sourceType: 'APPOINTMENT',
    status: 'IN_SERVICE',
    checkedInAt: new Date('2026-09-01T13:00:00Z'),
    mileageIn: 45210,
    notes: null,
    oilBrandRequested: 'Castrol',
    oilGradeRequested: '5W-30',
    queuePriorityClass: 'APPT_PROTECTED',
    partsReadiness: 'NOT_REQUIRED',
    appointment: { scheduledStartAt: new Date('2026-09-01T13:30:00Z'), notes: 'AC not cooling' },
    queueTicket: { id: 'qt-1', ticketNumber: 'B01-260901-004' },
    jobSheetDraft: { id: 'js-1', updatedAt: new Date('2026-09-01T13:10:00Z') },
    customer: {
      id: 'c-1',
      customerNumber: 'BC-1001',
      firstName: 'Jane',
      lastName: 'Doe',
      phone: '18765550000',
      email: 'jane@example.com',
      loyaltyMember: true,
      notificationOptInSms: true,
      notificationOptInEmail: false,
      notes: 'Prefers morning calls',
    },
    vehicle: {
      id: 'v-1',
      vehicleCode: 'SCABC123',
      plateNumber: 'ABC123',
      vin: 'VIN123',
      make: 'Toyota',
      model: 'RAV4',
      modelYear: 2021,
      color: 'Silver',
      odometer: 45210,
      serviceClass: 'SUV_CLASS',
      weightClass: 'STANDARD',
      fuelType: 'Gas',
      transmission: 'ATM',
      drivetrain: '4WD',
      engineNo: 'ENG-9',
      driveSide: 'LHD',
    },
  },
};

describe('getJobContext (CR-2026-101 §1/§3/§4)', () => {
  it('returns the customer slice, vehicle record, visit facts and expected time in one read', async () => {
    const h = build({
      serviceOrder: { findUnique: vi.fn(async () => contextOrder) },
      vehicleInspection: {
        findMany: vi.fn(async () => [
          {
            id: 'insp-1',
            inspectionNumber: 'INS-000123',
            status: 'IN_PROGRESS',
            kind: 'VEHICLE_INSPECTION',
            createdAt: new Date('2026-09-01T13:05:00Z'),
            comments: null,
            recommendations: [
              {
                id: 'rec-1',
                severity: 'RECOMMEND_SOON',
                description: 'Cabin filter clogged',
                customerDecision: 'PENDING',
                decisionAt: null,
                resultingServiceOrderId: null,
              },
            ],
          },
        ]),
      },
    });
    vi.spyOn(h.service, 'getWorkTiming').mockResolvedValue({ pausedMs: 0 } as never);

    const ctx = await h.service.getJobContext('so-1');

    // Customer: the read-only slice with contact preferences (§1).
    expect(ctx.customer).toMatchObject({
      firstName: 'Jane',
      phone: '18765550000',
      notificationOptInSms: true,
      notes: 'Prefers morning calls',
    });
    // Vehicle: the operational record incl. the authoritative class (§3).
    expect(ctx.vehicle).toMatchObject({ plateNumber: 'ABC123', serviceClass: 'SUV_CLASS', engineNo: 'ENG-9' });
    // Job facts (§4): services, expected time from the booked work, bay, notes labelled.
    expect(ctx.order.expectedMinutes).toBe(90);
    expect(ctx.order.assignments[0]).toMatchObject({ technicianName: 'Bob Smith', bay: 'B2' });
    expect(ctx.order.advisorNotes).toBe('Customer will wait on site');
    // Visit: number, source, appointment time + the appointment's stated concern.
    expect(ctx.visit).toMatchObject({
      visitNumber: 'B01-260901-004',
      sourceType: 'APPOINTMENT',
      appointmentNotes: 'AC not cooling',
      ticketNumber: 'B01-260901-004',
    });
    expect(ctx.visit.jobSheet.jobSheetNumber).toBe('JS-B01-260901-004');
    // Inspections with authorization states (§7/§15).
    expect(ctx.inspections[0].recommendations[0]).toMatchObject({
      customerDecision: 'PENDING',
      description: 'Cabin filter clogged',
    });
  });
});

describe('getVehicleHistory (CR-2026-101 §6/§7)', () => {
  it('maps previous visits with services, rework/parts flags and dated inspections', async () => {
    const h = build({
      serviceOrder: {
        findUnique: vi.fn(async () => ({
          serviceVisitId: 'sv-now',
          serviceVisit: { vehicleId: 'v-1' },
        })),
      },
      serviceVisit: {
        findMany: vi.fn(async () => [
          {
            id: 'sv-old',
            visitNumber: 'V-260610-002',
            sourceType: 'WALKIN',
            status: 'CLOSED',
            checkedInAt: new Date('2026-06-10T14:00:00Z'),
            createdAt: new Date('2026-06-10T13:55:00Z'),
            mileageIn: 41000,
            notes: 'Steering vibration',
            serviceOrders: [
              {
                status: 'CLOSED',
                notes: null,
                items: [{ serviceType: { name: 'Wheel Balance' } }],
                reworks: [{ id: 'rw-1' }],
                pauses: [{ id: 'p-1' }],
              },
            ],
            inspections: [
              {
                id: 'insp-old',
                inspectionNumber: 'INS-000090',
                status: 'SIGNED_OFF',
                createdAt: new Date('2026-06-10T14:20:00Z'),
                comments: 'Front-left tyre wear',
                recommendations: [
                  { severity: 'MONITOR', description: 'Monitor tyre wear', customerDecision: 'DECLINED' },
                ],
              },
            ],
          },
        ]),
      },
    });

    const rows = await h.service.getVehicleHistory('so-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      visitNumber: 'V-260610-002',
      mileageIn: 41000,
      services: ['Wheel Balance'],
      hadRework: true,
      hadPartsWait: true,
    });
    // Inspections always carry their DATE — an old inspection must never be
    // mistaken for the current one (§7).
    expect(rows[0].inspections[0].date).toEqual(new Date('2026-06-10T14:20:00Z'));
    expect(rows[0].inspections[0].recommendations[0]).toMatchObject({ customerDecision: 'DECLINED' });
  });
});
