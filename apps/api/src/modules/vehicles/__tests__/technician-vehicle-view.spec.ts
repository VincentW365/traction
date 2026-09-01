import { describe, it, expect, vi } from 'vitest';
import { VehiclesService } from '../vehicles.service';

/**
 * CR-2026-102 — the technician-safe vehicle view is CONTEXTUAL, not directory
 * access: a technician reads a vehicle only when it is tied to their own
 * assignments; advisors/managers pass straight through. The payload is a read
 * model — nothing in it is writable.
 */

const vehicleRow = {
  id: 'v-1',
  vehicleCode: 'SCABC123',
  plateNumber: 'ABC123',
  vin: 'VIN1',
  make: 'Toyota',
  model: 'Corolla',
  modelYear: 2020,
  color: 'Blue',
  odometer: 52000,
  serviceClass: 'SEDAN_CLASS',
  weightClass: 'STANDARD',
  fuelType: 'Gas',
  transmission: 'ATM',
  drivetrain: 'FWD',
  engineNo: 'ENG-1',
  driveSide: 'LHD',
  customer: { firstName: 'Jane', lastName: 'Doe', phone: '18765550000', notes: 'Prefers pickup after 4pm' },
};

function build(opts: { tech?: { id: string } | null; association?: { id: string } | null } = {}) {
  const prisma: any = {
    vehicle: { findUnique: vi.fn(async () => vehicleRow) },
    technician: { findUnique: vi.fn(async () => opts.tech ?? null) },
    technicianAssignment: { findFirst: vi.fn(async () => opts.association ?? null) },
    serviceVisit: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
  };
  const classification = {} as never;
  return { service: new VehiclesService(prisma as any, classification), prisma };
}

describe('getTechnicianView — contextual authorization (§2)', () => {
  it('a technician WITH an assignment on this vehicle reads the view', async () => {
    const h = build({ tech: { id: 'tech-1' }, association: { id: 'ta-1' } });
    const view = await h.service.getTechnicianView('v-1', { sub: 'u-1', role: 'TECHNICIAN' });

    // The gate checked THEIR assignments against THIS vehicle.
    expect(h.prisma.technicianAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          technicianId: 'tech-1',
          serviceOrder: { serviceVisit: { vehicleId: 'v-1' } },
        }),
      }),
    );
    expect(view.vehicle).toMatchObject({ plateNumber: 'ABC123', serviceClass: 'SEDAN_CLASS' });
    // Customer SUMMARY only — a name and phone, not a directory record.
    expect(view.customer).toEqual({
      name: 'Jane Doe',
      phone: '18765550000',
      serviceNotes: 'Prefers pickup after 4pm',
    });
  });

  it('a technician WITHOUT an assignment on this vehicle is refused, plainly', async () => {
    const h = build({ tech: { id: 'tech-1' }, association: null });
    await expect(
      h.service.getTechnicianView('v-1', { sub: 'u-1', role: 'TECHNICIAN' }),
    ).rejects.toThrow(/not on your work/i);
  });

  it('an account with no technician record and TECHNICIAN role is refused', async () => {
    const h = build({ tech: null });
    await expect(
      h.service.getTechnicianView('v-1', { sub: 'u-x', role: 'TECHNICIAN' }),
    ).rejects.toThrow(/not on your work/i);
  });

  it('advisor and manager pass through without the contextual gate', async () => {
    for (const role of ['SERVICE_ADVISOR', 'ADMIN']) {
      const h = build();
      const view = await h.service.getTechnicianView('v-1', { sub: 'u-a', role });
      expect(view.vehicle.plateNumber).toBe('ABC123');
      expect(h.prisma.technicianAssignment.findFirst).not.toHaveBeenCalled();
    }
  });

  it('current visit carries the concern, jobs and inspections; history flags rework/parts', async () => {
    const h = build({ tech: { id: 'tech-1' }, association: { id: 'ta-1' } });
    h.prisma.serviceVisit.findFirst = vi.fn(async () => ({
      id: 'sv-now',
      visitNumber: 'B01-260901-020',
      status: 'IN_SERVICE',
      sourceType: 'APPOINTMENT',
      checkedInAt: new Date(),
      mileageIn: 52100,
      notes: null,
      appointment: { scheduledStartAt: new Date(), notes: 'AC not cooling' },
      queueTicket: { id: 'qt-1', ticketNumber: 'B01-260901-020' },
      serviceOrders: [
        {
          id: 'so-1',
          status: 'IN_PROGRESS',
          notes: 'Customer waits on site',
          items: [{ serviceType: { name: 'AC Service' } }],
          assignments: [{ technician: { employeeCode: 'T-01', userAccount: { fullName: 'Bob Smith' } } }],
        },
      ],
      inspections: [{ id: 'i-1', inspectionNumber: 'INS-000200', status: 'IN_PROGRESS', kind: 'VEHICLE_INSPECTION', createdAt: new Date() }],
    }));
    h.prisma.serviceVisit.findMany = vi.fn(async () => [
      {
        id: 'sv-old',
        visitNumber: 'V-260601-001',
        sourceType: 'WALKIN',
        status: 'CLOSED',
        checkedInAt: new Date('2026-06-01T14:00:00Z'),
        createdAt: new Date('2026-06-01T13:55:00Z'),
        mileageIn: 48000,
        notes: 'Rattle from rear',
        serviceOrders: [
          {
            status: 'CLOSED',
            items: [{ serviceType: { name: 'Exhaust Repair' } }],
            reworks: [{ id: 'rw-1' }],
            pauses: [],
          },
        ],
        inspections: [],
      },
    ]);

    const view = await h.service.getTechnicianView('v-1', { sub: 'u-1', role: 'TECHNICIAN' });
    expect(view.currentVisit).toMatchObject({
      concern: 'AC not cooling',
      ticketNumber: 'B01-260901-020',
    });
    expect(view.currentVisit!.jobs[0]).toMatchObject({
      services: ['AC Service'],
      technicians: ['Bob Smith'],
      advisorNotes: 'Customer waits on site',
    });
    expect(view.history[0]).toMatchObject({
      services: ['Exhaust Repair'],
      hadRework: true,
      hadPartsWait: false,
    });
  });
});
