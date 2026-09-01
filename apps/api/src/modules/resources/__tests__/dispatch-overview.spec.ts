import { describe, it, expect, vi } from 'vitest';
import { ResourcesService } from '../resources.service';

/**
 * CR-2026-080 — dispatch overview read-model.
 *
 * Verifies the read-side bridge between System A (WorkResource/ResourceOccupancy)
 * and System B (ServiceOrder/TechnicianAssignment): enriched resource cards (tech +
 * service + parts + aging), technician load/state, needs-dispatch, unified blocked,
 * QC and overdue lists — plus the showOnDispatchBoard filter and the vocab-agnostic
 * open-assignment predicate. Pure mocks; no DB.
 */

const HOUR = 60 * 60 * 1000;

function build(data: {
  resources?: any[];
  technicians?: any[];
  needsDispatch?: any[];
  blockedOrders?: any[];
  blockedTickets?: any[];
  qcOrders?: any[];
  overdueOrders?: any[];
  // CR-2026-100 — technician pause requests awaiting acknowledgement.
  pendingPauses?: any[];
  // CR-2026-101 — open attention notes (safety / data reports).
  attentionNotes?: any[];
}) {
  const workResourceFindMany = vi.fn(async () => data.resources ?? []);
  const technicianFindMany = vi.fn(async () => data.technicians ?? []);
  const queueTicketFindMany = vi.fn(async ({ where }: any) => {
    if (where?.displayStatus === 'BLOCKED') return data.blockedTickets ?? [];
    return data.needsDispatch ?? [];
  });
  const serviceOrderFindMany = vi.fn(async ({ where }: any) => {
    if (where?.status === 'QC') return data.qcOrders ?? [];
    if (where?.startedAt) return data.overdueOrders ?? [];
    return data.blockedOrders ?? [];
  });

  const prisma: any = {
    workResource: { findMany: workResourceFindMany },
    technician: { findMany: technicianFindMany },
    queueTicket: { findMany: queueTicketFindMany },
    serviceOrder: { findMany: serviceOrderFindMany },
    // CR-2026-100 — the pause-approvals panel; none pending by default.
    serviceOrderPause: { findMany: vi.fn(async () => data.pendingPauses ?? []) },
    // CR-2026-101 — the attention-notes panel; none open by default.
    visitNote: { findMany: vi.fn(async () => data.attentionNotes ?? []) },
  };
  const audit = { log: vi.fn(async () => ({})) };
  const service = new ResourcesService(prisma as any, audit as any);
  return { service, prisma, workResourceFindMany, technicianFindMany };
}

const occupiedResource = (overrides: any = {}) => ({
  id: 'r1',
  code: 'BAY-1',
  name: 'Service Bay 1',
  resourceCategory: 'BAY',
  maxVehicleWeight: null,
  liftType: 'heavy',
  hasAlignment: false,
  hasDiagnostics: false,
  requiresMechanic: true,
  displayOrder: 0,
  operationalStatus: { isOperational: true, reason: null },
  reservations: [],
  occupancy: {
    status: 'OCCUPIED',
    technicianId: null,
    occupiedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min in
    expectedEndAt: null,
    serviceVisit: {
      id: 'sv1',
      partsReadiness: 'READY',
      customer: { id: 'c1', firstName: 'Jane', lastName: 'Doe' },
      vehicle: { id: 'v1', plateNumber: 'ABC123', make: 'Toyota', model: 'Corolla' },
      queueTicket: { id: 'qt1', ticketNumber: 'A007' },
      serviceOrders: [
        {
          id: 'so1',
          status: 'IN_PROGRESS',
          promisedCompletionAt: null,
          items: [{ serviceType: { name: 'Oil Change' } }],
          assignments: [
            {
              isPrimary: true,
              startedAt: new Date(Date.now() - 30 * 60 * 1000),
              endedAt: null,
              technician: { id: 'tech1', employeeCode: 'T-01', userAccount: { fullName: 'Bob Smith' } },
            },
          ],
        },
      ],
    },
  },
  ...overrides,
});

describe('ResourcesService.getDispatchOverview (CR-2026-080)', () => {
  it('only queries board-visible active resources (showOnDispatchBoard)', async () => {
    const h = build({});
    await h.service.getDispatchOverview('site-1');
    const where = ((h.workResourceFindMany.mock.calls as any[])[0][0] as any).where;
    expect(where).toMatchObject({ siteId: 'site-1', isActive: true, showOnDispatchBoard: true });
  });

  it('enriches an occupied resource with technician, service, parts and aging', async () => {
    const h = build({ resources: [occupiedResource()] });
    const res: any = await h.service.getDispatchOverview('site-1');
    const card = res.resources[0];
    expect(card.status).toBe('OCCUPIED');
    expect(card.currentJob.technicianName).toBe('Bob Smith'); // bridged from System B assignment
    expect(card.currentJob.serviceDescription).toBe('Oil Change');
    expect(card.currentJob.partsBlocked).toBe(false);
    expect(card.currentJob.aging).toBe(false); // 30 min < 120 threshold
    expect(res.summary.occupied).toBe(1);
  });

  it('flags aging when elapsed exceeds the 2h threshold', async () => {
    const stale = occupiedResource();
    stale.occupancy.occupiedAt = new Date(Date.now() - 3 * HOUR);
    stale.occupancy.serviceVisit.serviceOrders[0].assignments[0].startedAt = new Date(Date.now() - 3 * HOUR);
    const h = build({ resources: [stale] });
    const res: any = await h.service.getDispatchOverview('site-1');
    expect(res.resources[0].currentJob.aging).toBe(true);
    expect(res.resources[0].currentJob.elapsedMinutes).toBeGreaterThan(120);
  });

  it('marks partsBlocked when the visit parts readiness is REQUIRED_NOT_READY', async () => {
    const r = occupiedResource();
    r.occupancy.serviceVisit.partsReadiness = 'REQUIRED_NOT_READY';
    const h = build({ resources: [r] });
    const res: any = await h.service.getDispatchOverview('site-1');
    expect(res.resources[0].currentJob.partsBlocked).toBe(true);
  });

  it('computes technician load, state and current job', async () => {
    const technicians = [
      {
        id: 'tech1',
        employeeCode: 'T-01',
        userAccount: { fullName: 'Bob Smith' },
        skills: [{ skillCode: 'OIL', isPrimary: true }],
        availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }],
        assignments: [
          {
            startedAt: new Date(Date.now() - 20 * 60 * 1000),
            endedAt: null,
            serviceOrder: {
              id: 'so1',
              status: 'IN_PROGRESS',
              serviceVisit: { vehicle: { plateNumber: 'ABC123' }, queueTicket: { ticketNumber: 'A007' } },
            },
          },
        ],
      },
      {
        id: 'tech2',
        employeeCode: 'T-02',
        userAccount: { fullName: 'Amy Lee' },
        skills: [{ skillCode: 'BRAKES', isPrimary: true }],
        availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }],
        assignments: [],
      },
      {
        id: 'tech3',
        employeeCode: 'T-03',
        userAccount: { fullName: 'Away Guy' },
        skills: [],
        availability: [{ status: 'ABSENT', shiftStart: '08:00', shiftEnd: '17:00' }],
        assignments: [],
      },
    ];
    const h = build({ technicians });
    const res: any = await h.service.getDispatchOverview('site-1');
    const [t1, t2, t3] = res.technicianLoad;
    expect(t1).toMatchObject({ state: 'BUSY', openAssignments: 1 });
    expect(t1.currentJob.ticketNumber).toBe('A007');
    expect(t2).toMatchObject({ state: 'IDLE', openAssignments: 0 });
    expect(t3.state).toBe('ABSENT');
    expect(res.summary).toMatchObject({ techniciansActive: 3, techniciansBusy: 1, techniciansIdle: 1, techniciansAbsent: 1 });
  });

  // CR-2026-100 — the board distinguishes active from held work: two jobs waiting
  // on parts read as ASSIGNED-with-held-work, not BUSY, and the workload breakdown
  // says exactly what the technician is carrying.
  it('multi-job technician: held jobs do not read as BUSY; the breakdown says what is held', async () => {
    const mkAssignment = (orderId: string, status: string, ticket: string) => ({
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      endedAt: null,
      serviceOrder: {
        id: orderId,
        status,
        serviceVisit: { vehicle: { plateNumber: 'P-' + orderId }, queueTicket: { ticketNumber: ticket } },
      },
    });
    const technicians = [
      {
        id: 'tech1',
        employeeCode: 'T-01',
        userAccount: { fullName: 'Bob Smith' },
        skills: [],
        availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }],
        assignments: [
          mkAssignment('soA', 'WAITING_PARTS', 'A001'),
          mkAssignment('soB', 'WAITING_CUSTOMER', 'A002'),
        ],
      },
      {
        id: 'tech2',
        employeeCode: 'T-02',
        userAccount: { fullName: 'Amy Lee' },
        skills: [],
        availability: [{ status: 'AVAILABLE', shiftStart: '08:00', shiftEnd: '17:00' }],
        assignments: [
          mkAssignment('soC', 'IN_PROGRESS', 'A003'),
          mkAssignment('soD', 'WAITING_PARTS', 'A004'),
        ],
      },
    ];
    const h = build({ technicians });
    const res: any = await h.service.getDispatchOverview('site-1');
    const [t1, t2] = res.technicianLoad;

    // Both of Bob's jobs are held — he is available for more work, and reads so.
    expect(t1).toMatchObject({ state: 'ASSIGNED', openAssignments: 2, activeJobs: 0, heldJobs: 2 });
    expect(t1.currentJob).toBeNull();
    expect(t1.jobs.map((j: any) => j.held)).toEqual([true, true]);

    // Amy is genuinely working one job while another waits on parts.
    expect(t2).toMatchObject({ state: 'BUSY', activeJobs: 1, heldJobs: 1 });
    expect(t2.currentJob.ticketNumber).toBe('A003');
  });

  // CR-2026-100 — pending pause requests surface on the board, never buried in a log.
  it('surfaces technician pause requests awaiting acknowledgement', async () => {
    const pendingPauses = [
      {
        id: 'p1',
        reasonCode: 'WAITING_PARTS',
        notes: 'caliper on order',
        startedAt: new Date(Date.now() - 18 * 60 * 1000),
        technicianId: 'tech1',
        enteredOnBehalf: false,
        serviceOrder: {
          id: 'so1',
          status: 'WAITING_PARTS',
          items: [{ serviceType: { name: 'Brake Job' } }],
          serviceVisit: {
            id: 'sv1',
            customer: { firstName: 'Jane', lastName: 'Doe' },
            vehicle: { plateNumber: 'ABC123' },
            queueTicket: { id: 'qt1', ticketNumber: 'A007' },
          },
        },
      },
    ];
    const technicians = [
      {
        id: 'tech1',
        employeeCode: 'T-01',
        userAccount: { fullName: 'Bob Smith' },
        skills: [],
        availability: [],
        assignments: [],
      },
    ];
    const h = build({ technicians, pendingPauses });
    const res: any = await h.service.getDispatchOverview('site-1');

    expect(res.summary.pauseApprovals).toBe(1);
    expect(res.pauseApprovals[0]).toMatchObject({
      pauseId: 'p1',
      queueTicketId: 'qt1',
      ticketNumber: 'A007',
      technicianName: 'Bob Smith',
      reasonCode: 'WAITING_PARTS',
      enteredOnBehalf: false,
    });
    expect(res.pauseApprovals[0].waitingMinutes).toBeGreaterThanOrEqual(17);
  });

  it('lists needs-dispatch tickets with a service description', async () => {
    const needsDispatch = [
      {
        id: 'qt2',
        ticketNumber: 'A008',
        queueRank: 1,
        displayStatus: 'WAITING',
        blockedReason: null,
        serviceVisit: {
          id: 'sv2',
          partsReadiness: 'NOT_REQUIRED',
          checkedInAt: new Date(Date.now() - 15 * 60 * 1000),
          customer: { firstName: 'Sam', lastName: 'Ray' },
          vehicle: { plateNumber: 'XYZ789', make: 'Honda', model: 'Civic' },
          appointment: { services: [{ serviceType: { name: 'Brake Inspection' } }] },
        },
      },
    ];
    const h = build({ needsDispatch });
    const res: any = await h.service.getDispatchOverview('site-1');
    expect(res.needsDispatch).toHaveLength(1);
    expect(res.needsDispatch[0]).toMatchObject({
      queueTicketId: 'qt2',
      ticketNumber: 'A008',
      serviceDescription: 'Brake Inspection',
    });
    expect(res.summary.needsDispatch).toBe(1);
  });

  it('unifies blocked orders and blocked tickets, deduping by visit', async () => {
    const blockedOrders = [
      {
        id: 'so9',
        status: 'WAITING_PARTS',
        updatedAt: new Date(Date.now() - 45 * 60 * 1000),
        items: [{ serviceType: { name: 'Timing Belt' } }],
        serviceVisit: {
          id: 'svShared',
          customer: { firstName: 'Pat', lastName: 'Kim' },
          vehicle: { plateNumber: 'BLK001' },
          queueTicket: { ticketNumber: 'A100' },
        },
      },
    ];
    const blockedTickets = [
      // same visit as the order above → must be deduped away
      {
        id: 'qtShared',
        ticketNumber: 'A100',
        blockedReason: 'Missing required parts',
        generatedAt: new Date(),
        serviceVisit: { id: 'svShared', customer: { firstName: 'Pat', lastName: 'Kim' }, vehicle: { plateNumber: 'BLK001' } },
      },
      // distinct visit → kept
      {
        id: 'qtOther',
        ticketNumber: 'A101',
        blockedReason: 'No qualified technician available',
        generatedAt: new Date(),
        serviceVisit: { id: 'svOther', customer: { firstName: 'Lee', lastName: 'Fox' }, vehicle: { plateNumber: 'BLK002' } },
      },
    ];
    const h = build({ blockedOrders, blockedTickets });
    const res: any = await h.service.getDispatchOverview('site-1');
    expect(res.blocked).toHaveLength(2); // order + the distinct ticket; shared ticket deduped
    expect(res.blocked.find((b: any) => b.serviceVisitId === 'svShared')).toMatchObject({
      reason: 'Waiting on parts',
      serviceOrderId: 'so9',
    });
    expect(res.blocked.find((b: any) => b.serviceVisitId === 'svOther')).toMatchObject({
      queueTicketId: 'qtOther',
      status: 'BLOCKED',
    });
  });

  it('surfaces QC and overdue lists', async () => {
    const qcOrders = [
      {
        id: 'soQc',
        completedAt: new Date(Date.now() - 10 * 60 * 1000),
        serviceVisit: {
          id: 'svQc',
          customer: { firstName: 'Q', lastName: 'C' },
          vehicle: { plateNumber: 'QC001' },
          queueTicket: { ticketNumber: 'A200' },
        },
      },
    ];
    const overdueOrders = [
      {
        id: 'soOd',
        status: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 4 * HOUR),
        serviceVisit: {
          id: 'svOd',
          customer: { firstName: 'O', lastName: 'D' },
          vehicle: { plateNumber: 'OD001' },
          queueTicket: { ticketNumber: 'A201' },
        },
      },
    ];
    const h = build({ qcOrders, overdueOrders });
    const res: any = await h.service.getDispatchOverview('site-1');
    expect(res.readyForQc).toHaveLength(1);
    expect(res.readyForQc[0].ticketNumber).toBe('A200');
    expect(res.overdue).toHaveLength(1);
    expect(res.overdue[0].elapsedMinutes).toBeGreaterThan(120);
    expect(res.summary).toMatchObject({ readyForQc: 1, overdue: 1 });
  });

  it('falls back to occupancy.technicianId when no System-B assignment exists', async () => {
    const r = occupiedResource();
    r.occupancy.technicianId = 'tech1';
    r.occupancy.serviceVisit.serviceOrders[0].assignments = []; // no System-B assignment
    const technicians = [
      {
        id: 'tech1',
        employeeCode: 'T-01',
        userAccount: { fullName: 'Bob Smith' },
        skills: [],
        availability: [],
        assignments: [],
      },
    ];
    const h = build({ resources: [r], technicians });
    const res: any = await h.service.getDispatchOverview('site-1');
    expect(res.resources[0].currentJob.technicianName).toBe('Bob Smith');
  });
});
