/**
 * Test Data Sandbox — scenarios (CR-2026-020, T-b).
 *
 * Each scenario creates a realistic, disposable slice of the operational graph via
 * DIRECT Prisma writes (mirroring the services' row shapes/statuses — no Nest boot,
 * no domain-logic changes). Every created row is recorded for the manifest, and the
 * three anchors (Customer/Vehicle/ServiceVisit) carry testDataRunId.
 *
 * `plan` is the static per-scenario row count used by the dry-run; a unit test
 * asserts run() creates EXACTLY `plan` (drift guard), so dry-run never lies.
 *
 * Values are obviously fake (firstName VWTEST, 876-555 phones, *.test emails,
 * TestMake/TestModel). No real PII is ever created.
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  VisitSourceType,
  ServiceVisitStatus,
  QueueDisplayStatus,
  AppointmentStatus,
  ServiceOrderStatus,
  PaymentStatus,
  TransportDirection,
  TransportStatus,
  VehicleServiceClass,
} from '@prisma/client';
import { ManifestRecorder } from './manifest';
import {
  TEST_CUSTOMER_FIRST_NAME,
  TEST_VEHICLE_CODE_PREFIX,
  formatTestCustomerNumber,
  assertCustomerNumberSafe,
} from './guards';

export type ScenarioPlan = Record<string, number>;

export interface TestInfra {
  siteId: string;
  advisorUserId: string;
  technicianId: string;
  bayId: string;
  generalServiceTypeId: string;
  generalServiceTypeDuration: number;
  transportServiceTypeId?: string;
}

export interface ScenarioContext extends TestInfra {
  runId: string;
  label: string;
  runShort: string;
}

export interface Scenario {
  key: string;
  description: string;
  plan: ScenarioPlan;
  requiresTransport?: boolean;
  run(tx: Prisma.TransactionClient, ctx: ScenarioContext, rec: ManifestRecorder, alloc: RunAllocator): Promise<void>;
}

/** Allocates per-run unique customer numbers, scenario indexes and ticket numbers. */
export class RunAllocator {
  private cust: number;
  private idx = 0;
  private ticket = 0;
  constructor(custStart: number) {
    this.cust = custStart;
  }
  nextCustomerSeq(): number {
    return this.cust++;
  }
  nextIndex(): number {
    return ++this.idx;
  }
  nextTicketSeq(): number {
    return ++this.ticket;
  }
}

// --- helpers ---------------------------------------------------------------
const addHours = (d: Date, h: number): Date => new Date(d.getTime() + h * 3_600_000);

async function createAnchor(
  tx: Prisma.TransactionClient,
  ctx: ScenarioContext,
  rec: ManifestRecorder,
  alloc: RunAllocator,
): Promise<{ customerId: string; vehicleId: string; idx: number }> {
  const idx = alloc.nextIndex();
  const customerNumber = formatTestCustomerNumber(alloc.nextCustomerSeq());
  assertCustomerNumberSafe(customerNumber);

  const customer = await tx.customer.create({
    data: {
      customerNumber,
      firstName: TEST_CUSTOMER_FIRST_NAME,
      lastName: `Sandbox-${idx}`,
      phone: `876-555-${String(1000 + (idx % 9000)).slice(-4)}`,
      email: `vwtest+${ctx.runShort}-${idx}@example.test`,
      notificationOptInSms: true,
      notificationOptInEmail: true,
      notes: `Test data — run ${ctx.label}`,
      testDataRunId: ctx.runId,
    },
  });
  rec.add('Customer', customer.id);

  const vehicle = await tx.vehicle.create({
    data: {
      customerId: customer.id,
      vehicleCode: `${TEST_VEHICLE_CODE_PREFIX}-${ctx.runShort}-${idx}`,
      plateNumber: `VWT${String(idx).padStart(4, '0')}`,
      make: 'TestMake',
      model: 'TestModel',
      modelYear: 2020,
      color: 'TestColor',
      odometer: 50000,
      serviceClass: VehicleServiceClass.SEDAN_CLASS, // Rule 3 eligible; deterministic
      testDataRunId: ctx.runId,
    },
  });
  rec.add('Vehicle', vehicle.id);
  return { customerId: customer.id, vehicleId: vehicle.id, idx };
}

async function createVisit(
  tx: Prisma.TransactionClient,
  ctx: ScenarioContext,
  rec: ManifestRecorder,
  opts: {
    customerId: string;
    vehicleId: string;
    sourceType: VisitSourceType;
    status: ServiceVisitStatus;
    appointmentId?: string;
    mileageOut?: number;
  },
): Promise<string> {
  const t = new Date();
  const visit = await tx.serviceVisit.create({
    data: {
      siteId: ctx.siteId,
      customerId: opts.customerId,
      vehicleId: opts.vehicleId,
      appointmentId: opts.appointmentId,
      sourceType: opts.sourceType,
      status: opts.status,
      arrivalAt: t,
      checkInStartedAt: t,
      checkedInAt: t,
      mileageIn: 50000,
      mileageOut: opts.mileageOut,
      partsReadiness: 'NOT_REQUIRED',
      customerStatusToken: randomUUID(),
      tokenExpiresAt: addHours(t, 24),
      testDataRunId: ctx.runId,
    },
  });
  rec.add('ServiceVisit', visit.id);
  return visit.id;
}

async function createTicket(
  tx: Prisma.TransactionClient,
  ctx: ScenarioContext,
  rec: ManifestRecorder,
  alloc: RunAllocator,
  visitId: string,
  displayStatus: QueueDisplayStatus,
): Promise<string> {
  const seq = alloc.nextTicketSeq();
  const ticket = await tx.queueTicket.create({
    data: {
      serviceVisitId: visitId,
      ticketNumber: `VWT-${ctx.runShort}-${seq}`,
      checkinSequence: seq,
      displayStatus,
    },
  });
  rec.add('QueueTicket', ticket.id);
  return ticket.id;
}

async function recordStatus(
  tx: Prisma.TransactionClient,
  ctx: ScenarioContext,
  rec: ManifestRecorder,
  entityType: string,
  entityId: string,
  fromStatus: string | null,
  toStatus: string,
  reasonCode?: string,
): Promise<void> {
  const sh = await tx.statusHistory.create({
    data: { entityType, entityId, fromStatus, toStatus, changedByUserId: ctx.advisorUserId, reasonCode },
  });
  rec.add('StatusHistory', sh.id);
}

async function recordAudit(
  tx: Prisma.TransactionClient,
  ctx: ScenarioContext,
  rec: ManifestRecorder,
  action: string,
  entityType: string,
  entityId: string,
  notes?: string,
): Promise<void> {
  const a = await tx.auditLog.create({
    data: { actorUserId: ctx.advisorUserId, action, entityType, entityId, notes },
  });
  rec.add('AuditLog', a.id);
}

// --- scenarios -------------------------------------------------------------
const walkin: Scenario = {
  key: 'walkin',
  description: 'Walk-in customer checked in and waiting in the queue.',
  plan: { Customer: 1, Vehicle: 1, ServiceVisit: 1, QueueTicket: 1, StatusHistory: 1 },
  async run(tx, ctx, rec, alloc) {
    const { customerId, vehicleId } = await createAnchor(tx, ctx, rec, alloc);
    const visitId = await createVisit(tx, ctx, rec, {
      customerId, vehicleId, sourceType: VisitSourceType.WALKIN, status: ServiceVisitStatus.CHECKED_IN,
    });
    await createTicket(tx, ctx, rec, alloc, visitId, QueueDisplayStatus.PENDING_RANK);
    await recordStatus(tx, ctx, rec, 'ServiceVisit', visitId, null, 'CHECKED_IN');
  },
};

const appointment: Scenario = {
  key: 'appointment',
  description: 'Appointment customer, checked in, waiting in the queue.',
  plan: { Customer: 1, Vehicle: 1, Appointment: 1, AppointmentService: 1, ServiceVisit: 1, QueueTicket: 1, StatusHistory: 2 },
  async run(tx, ctx, rec, alloc) {
    const { customerId, vehicleId } = await createAnchor(tx, ctx, rec, alloc);
    const scheduledStartAt = addHours(new Date(), 24);
    scheduledStartAt.setHours(10, 0, 0, 0);
    const appt = await tx.appointment.create({
      data: {
        siteId: ctx.siteId, customerId, vehicleId, scheduledStartAt,
        status: AppointmentStatus.CHECKED_IN, confirmationStatus: 'CONFIRMED', sourceChannel: 'STAFF',
        createdByUserId: ctx.advisorUserId, notes: `Test data — run ${ctx.label}`,
      },
    });
    rec.add('Appointment', appt.id);
    const as = await tx.appointmentService.create({
      data: { appointmentId: appt.id, serviceTypeId: ctx.generalServiceTypeId, qty: 1 },
    });
    rec.add('AppointmentService', as.id);
    const visitId = await createVisit(tx, ctx, rec, {
      customerId, vehicleId, sourceType: VisitSourceType.APPOINTMENT, status: ServiceVisitStatus.CHECKED_IN, appointmentId: appt.id,
    });
    await createTicket(tx, ctx, rec, alloc, visitId, QueueDisplayStatus.PENDING_RANK);
    await recordStatus(tx, ctx, rec, 'Appointment', appt.id, 'DRAFT', 'CHECKED_IN');
    await recordStatus(tx, ctx, rec, 'ServiceVisit', visitId, null, 'CHECKED_IN');
  },
};

const completed: Scenario = {
  key: 'completed',
  description: 'Full happy path: assigned, worked, closed and paid.',
  plan: {
    Customer: 1, Vehicle: 1, ServiceVisit: 1, QueueTicket: 1,
    ServiceOrder: 1, ServiceOrderItem: 1, TechnicianAssignment: 1, StatusHistory: 4, AuditLog: 1,
  },
  async run(tx, ctx, rec, alloc) {
    const { customerId, vehicleId } = await createAnchor(tx, ctx, rec, alloc);
    const visitId = await createVisit(tx, ctx, rec, {
      customerId, vehicleId, sourceType: VisitSourceType.WALKIN, status: ServiceVisitStatus.CLOSED, mileageOut: 50_250,
    });
    await createTicket(tx, ctx, rec, alloc, visitId, QueueDisplayStatus.COMPLETED);

    const t = new Date();
    const order = await tx.serviceOrder.create({
      data: {
        serviceVisitId: visitId, advisorUserId: ctx.advisorUserId,
        status: ServiceOrderStatus.CLOSED, paymentStatus: PaymentStatus.PAID,
        startedAt: addHours(t, -2), completedAt: addHours(t, -1), closedAt: t, promisedCompletionAt: t,
        notes: `Test data — run ${ctx.label}`,
      },
    });
    rec.add('ServiceOrder', order.id);
    const item = await tx.serviceOrderItem.create({
      data: {
        serviceOrderId: order.id, serviceTypeId: ctx.generalServiceTypeId,
        estimateMinutes: ctx.generalServiceTypeDuration, actualMinutes: ctx.generalServiceTypeDuration, status: 'COMPLETED',
      },
    });
    rec.add('ServiceOrderItem', item.id);
    const asg = await tx.technicianAssignment.create({
      data: {
        serviceOrderId: order.id, technicianId: ctx.technicianId, bayId: ctx.bayId,
        status: 'COMPLETED', isPrimary: true, startedAt: addHours(t, -2), endedAt: addHours(t, -1),
      },
    });
    rec.add('TechnicianAssignment', asg.id);

    await recordStatus(tx, ctx, rec, 'ServiceVisit', visitId, null, 'CHECKED_IN');
    await recordStatus(tx, ctx, rec, 'ServiceVisit', visitId, 'IN_SERVICE', 'CLOSED');
    await recordStatus(tx, ctx, rec, 'ServiceOrder', order.id, null, 'DRAFT');
    await recordStatus(tx, ctx, rec, 'ServiceOrder', order.id, 'IN_PROGRESS', 'CLOSED');
    await recordAudit(tx, ctx, rec, 'SERVICE_VISIT_COMPLETED', 'ServiceVisit', visitId, 'Test completion');
  },
};

const abandon: Scenario = {
  key: 'abandon',
  description: 'No-show / abandoned visit (exercises the P3 transition shape).',
  plan: { Customer: 1, Vehicle: 1, ServiceVisit: 1, QueueTicket: 1, StatusHistory: 2, AuditLog: 1 },
  async run(tx, ctx, rec, alloc) {
    const { customerId, vehicleId } = await createAnchor(tx, ctx, rec, alloc);
    const visitId = await createVisit(tx, ctx, rec, {
      customerId, vehicleId, sourceType: VisitSourceType.WALKIN, status: ServiceVisitStatus.ABANDONED,
    });
    await createTicket(tx, ctx, rec, alloc, visitId, QueueDisplayStatus.CANCELLED);
    await recordStatus(tx, ctx, rec, 'ServiceVisit', visitId, null, 'CHECKED_IN');
    await recordStatus(tx, ctx, rec, 'ServiceVisit', visitId, 'CHECKED_IN', 'ABANDONED', 'NO_SHOW');
    await recordAudit(tx, ctx, rec, 'SERVICE_VISIT_ABANDONED', 'ServiceVisit', visitId, 'Test abandon');
  },
};

const transport: Scenario = {
  key: 'transport',
  description: 'Visit with a transport request (REQUESTED; mirrors TransportService.create).',
  requiresTransport: true,
  plan: { Customer: 1, Vehicle: 1, ServiceVisit: 1, QueueTicket: 1, TransportRequest: 1, StatusHistory: 2 },
  async run(tx, ctx, rec, alloc) {
    const { customerId, vehicleId } = await createAnchor(tx, ctx, rec, alloc);
    const visitId = await createVisit(tx, ctx, rec, {
      customerId, vehicleId, sourceType: VisitSourceType.WALKIN, status: ServiceVisitStatus.IN_SERVICE,
    });
    await createTicket(tx, ctx, rec, alloc, visitId, QueueDisplayStatus.IN_SERVICE);
    const tr = await tx.transportRequest.create({
      data: {
        serviceVisitId: visitId, direction: TransportDirection.DROPOFF, status: TransportStatus.REQUESTED,
        originAddress: "Bert's Service Centre (test)", destinationAddress: '123 Test Avenue (test)',
        requestedPickupAt: addHours(new Date(), 2), notes: `Test data — run ${ctx.label}`,
      },
    });
    rec.add('TransportRequest', tr.id);
    await recordStatus(tx, ctx, rec, 'ServiceVisit', visitId, null, 'CHECKED_IN');
    await recordStatus(tx, ctx, rec, 'TransportRequest', tr.id, null, 'REQUESTED');
  },
};

export const SCENARIOS: Record<string, Scenario> = {
  appointment, walkin, completed, abandon, transport,
};

/** v1 default set (transport is opt-in: it needs a transport-eligible ServiceType). */
export const DEFAULT_SCENARIO_KEYS = ['appointment', 'walkin', 'completed', 'abandon'];
export const ALL_SCENARIO_KEYS = Object.keys(SCENARIOS);

export function resolveScenarioKeys(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [...DEFAULT_SCENARIO_KEYS];
  if (raw.trim().toLowerCase() === 'all') return [...ALL_SCENARIO_KEYS];
  const keys = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = keys.filter((k) => !SCENARIOS[k]);
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(', ')}. Known: ${ALL_SCENARIO_KEYS.join(', ')}`);
  return keys;
}

/** Aggregate the static plans for the dry-run (pure; no DB). */
export function summarizePlans(
  keys: string[],
  repeat: number,
): { perScenario: Array<{ key: string; description: string; plan: ScenarioPlan }>; totals: ScenarioPlan; totalRows: number } {
  const perScenario: Array<{ key: string; description: string; plan: ScenarioPlan }> = [];
  const totals: ScenarioPlan = {};
  for (const key of keys) {
    const s = SCENARIOS[key];
    perScenario.push({ key, description: s.description, plan: s.plan });
    for (const [table, n] of Object.entries(s.plan)) totals[table] = (totals[table] ?? 0) + n * repeat;
  }
  const totalRows = Object.values(totals).reduce((a, b) => a + b, 0);
  return { perScenario, totals, totalRows };
}

/** Flatten selected keys into the execution list (each scenario `repeat` times). */
export function expandScenarioKeys(keys: string[], repeat: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < repeat; i++) out.push(...keys);
  return out;
}
