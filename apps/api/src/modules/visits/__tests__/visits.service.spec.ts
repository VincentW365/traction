import { describe, it, expect, vi } from 'vitest';
import { VisitsService } from '../visits.service';

/**
 * CR-2026-097 — Visit Record aggregate, activity timeline, consolidated files.
 */

const BASE_VISIT = {
  id: 'visit-1',
  visitNumber: 'B01-260824-002',
  status: 'CLOSED',
  sourceType: 'WALKIN',
  notes: null,
  mileageIn: 50000,
  mileageOut: null,
  createdAt: new Date('2026-08-24T13:00:00Z'),
  arrivalAt: new Date('2026-08-24T13:00:00Z'),
  checkedInAt: new Date('2026-08-24T13:05:00Z'),
  customer: { id: 'c1', customerNumber: 'CN1', firstName: 'Vincent', lastName: 'Wilson', phone: '876', email: null },
  vehicle: { id: 'veh1', vehicleCode: 'SC1', plateNumber: '1234 AB', make: 'Honda', model: 'Grace', modelYear: 2020, odometer: 50000 },
  site: { id: 's1', name: "Bert's", code: 'B01' },
  queueTicket: { id: 'qt1', ticketNumber: 'B01-260824-002', ticketReference: 'B01-260824-002', displayTicketNumber: 'B01-002', displayStatus: 'COMPLETED', queueRank: null, generatedAt: new Date('2026-08-24T13:05:30Z') },
  appointment: null,
  serviceOrders: [
    {
      id: 'so1', status: 'CLOSED', createdAt: new Date('2026-08-24T13:06:00Z'),
      startedAt: new Date('2026-08-24T13:30:00Z'), completedAt: new Date('2026-08-24T15:00:00Z'),
      advisorUserId: null,
      items: [{ id: 'it1', status: 'COMPLETED', serviceType: { code: 'OIL-01', name: 'Oil Change' } }],
      assignments: [{
        id: 'a1', isPrimary: true, status: 'ASSIGNED', assignedAt: new Date('2026-08-24T13:25:00Z'),
        startedAt: null, endedAt: null,
        technician: { id: 't1', employeeCode: 'TECH-001', userAccount: { fullName: 'Owen Josephs' } },
        resource: { id: 'r1', code: 'BAY-2', name: 'Bay 2' },
        bay: null,
      }],
    },
  ],
  inspections: [
    {
      id: 'insp1', inspectionNumber: 'INS-000007', kind: 'VEHICLE_INSPECTION', status: 'COMPLETED',
      createdAt: new Date('2026-08-24T13:10:00Z'), completedAt: new Date('2026-08-24T13:40:00Z'),
      signedOffAt: null, closedAt: null, skippedAt: null, skipReason: null, cancelledAt: null,
      performedByUserId: 'u-tech',
      _count: { items: 14, photos: 6, recommendations: 2 },
    },
  ],
  maintenanceRecommendations: [],
  jobSheetDraft: { id: 'js1', createdAt: new Date('2026-08-24T13:12:00Z'), updatedAt: new Date('2026-08-24T14:00:00Z'), signatureImage: 'data:image/png;base64,x', updatedByUserId: 'u-adv' },
};

function build(overrides?: { visit?: Record<string, unknown> }) {
  const visit = { ...BASE_VISIT, ...(overrides?.visit ?? {}) };
  const prisma: Record<string, unknown> = {
    serviceVisit: {
      findUnique: vi.fn(async () => visit),
      findFirst: vi.fn(async () => ({ id: visit.id, visitNumber: visit.visitNumber })),
    },
    userAccount: {
      findMany: vi.fn(async () => [
        { id: 'u-tech', fullName: 'Owen Josephs' },
        { id: 'u-adv', fullName: 'Admin User' },
      ]),
    },
    statusHistory: { findMany: vi.fn(async () => []) },
    queueEvent: { findMany: vi.fn(async () => []) },
    auditLog: { findMany: vi.fn(async () => []) },
    notificationLog: { findMany: vi.fn(async () => []) },
    technicianAssignment: { findMany: vi.fn(async () => []) },
  };
  return { service: new VisitsService(prisma as never), prisma, visit };
}

describe('getRecord', () => {
  it('aggregates the visit with derived timing, job sheet number, and inspector names', async () => {
    const { service } = build();
    const r = await service.getRecord('visit-1');
    expect(r.visitNumber).toBe('B01-260824-002');
    expect(r.derived.workStartedAt).toEqual(new Date('2026-08-24T13:30:00Z'));
    expect(r.derived.completedAt).toEqual(new Date('2026-08-24T15:00:00Z'));
    expect(r.derived.durationMinutes).toBe(90);
    expect(r.jobSheet!.jobSheetNumber).toBe('JS-B01-260824-002');
    expect(r.jobSheet!.hasSignature).toBe(true);
    expect(r.jobSheet!.updatedBy).toBe('Admin User');
    expect(r.inspections[0].inspector).toBe('Owen Josephs');
    expect(r.inspections[0]._count).toEqual({ items: 14, photos: 6, recommendations: 2 });
  });

  it('falls back to the ticket number when visitNumber is unset (pre-backfill row)', async () => {
    const { service } = build({ visit: { visitNumber: null } });
    const r = await service.getRecord('visit-1');
    expect(r.visitNumber).toBe('B01-260824-002');
  });

  it('404s cleanly for an unknown visit', async () => {
    const { service, prisma } = build();
    (prisma.serviceVisit as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue(null);
    await expect(service.getRecord('nope')).rejects.toThrow('Visit not found');
  });
});

describe('getTimeline', () => {
  it('merges lifecycle, inspections, job sheet, and assignments in chronological order', async () => {
    const { service, prisma } = build();
    (prisma.technicianAssignment as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([
      {
        assignedAt: new Date('2026-08-24T13:25:00Z'), endedAt: null, isPrimary: true,
        technician: { userAccount: { fullName: 'Owen Josephs' } },
        resource: { name: 'Bay 2', code: 'BAY-2' }, bay: null,
      },
    ]);
    const events = await service.getTimeline('visit-1');

    const labels = events.map((e) => e.label);
    expect(labels[0]).toBe('Walk-in registered');
    expect(labels).toContain('Customer checked in');
    expect(labels).toContain('Queue ticket B01-260824-002 created');
    expect(labels).toContain('Technician assigned: Owen Josephs (Bay 2)');
    expect(labels).toContain('Vehicle inspection INS-000007 started');
    expect(labels).toContain('Vehicle inspection INS-000007 completed');
    expect(labels).toContain('Job sheet started');
    expect(labels).toContain('Job sheet saved');

    // Strictly chronological
    for (let i = 1; i < events.length; i++) {
      expect(events[i].at.getTime()).toBeGreaterThanOrEqual(events[i - 1].at.getTime());
    }
    // Actor resolution through the scalar user ids
    const started = events.find((e) => e.type === 'INSPECTION_STARTED');
    expect(started!.actor).toBe('Owen Josephs');
  });

  it('skips queue re-rank noise but keeps meaningful queue events', async () => {
    const { service, prisma } = build();
    (prisma.queueEvent as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([
      { eventType: 'RANK_CHANGED', createdAt: new Date('2026-08-24T13:06:00Z'), actor: null, reasonCode: null },
      { eventType: 'CALLED', createdAt: new Date('2026-08-24T13:20:00Z'), actor: { fullName: 'Admin User' }, reasonCode: null },
    ]);
    const events = await service.getTimeline('visit-1');
    expect(events.some((e) => e.type === 'QUEUE_RANK_CHANGED')).toBe(false);
    expect(events.some((e) => e.type === 'QUEUE_CALLED')).toBe(true);
  });
});

describe('getFiles', () => {
  it('groups photos by originating inspection and includes the job-sheet signature entry', async () => {
    const { service, prisma } = build();
    (prisma.serviceVisit as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValue({
      id: 'visit-1',
      inspections: [
        {
          id: 'insp1', inspectionNumber: 'INS-000007', kind: 'PRE_INSPECTION', status: 'COMPLETED',
          photos: [{ id: 'p1', caption: 'Front vehicle photo', category: 'EXTERIOR', mimeType: 'image/jpeg', byteSize: 1000, createdAt: new Date() }],
        },
        { id: 'insp2', inspectionNumber: 'INS-000008', kind: 'VEHICLE_INSPECTION', status: 'COMPLETED', photos: [] },
      ],
      jobSheetDraft: { id: 'js1', signatureImage: 'data:image/png;base64,x', updatedAt: new Date() },
    });
    const files = await service.getFiles('visit-1');
    // Empty-photo inspections drop out; the source association is preserved.
    expect(files.groups).toHaveLength(2);
    expect(files.groups[0]).toMatchObject({ source: 'PRE_INSPECTION', inspectionNumber: 'INS-000007' });
    expect(files.groups[1]).toMatchObject({ source: 'JOB_SHEET', hasSignature: true });
  });
});

describe('resolveByNumber', () => {
  it('resolves a visit number to its id', async () => {
    const { service } = build();
    const r = await service.resolveByNumber('B01-260824-002');
    expect(r.id).toBe('visit-1');
  });
});
