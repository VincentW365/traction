/**
 * Test Data Sandbox — cleanup (CR-2026-020, T-c).
 *
 * Manifest-driven, dry-run-first, backup-gated removal of a single test run.
 * Reads ExternalSystemRef(TEST_DATA_RUN, externalId=runId), groups by entityType,
 * runs the full safety gauntlet, and (only on --commit, with a backup) deletes in
 * documented child→parent dependency order inside ONE transaction, then marks the
 * run CLEANED_UP and writes a real (non-test) AuditLog.
 *
 * NEVER deletes by name/date/broad filter; NEVER touches imported/historical or
 * shared-infra rows; refuses on any protected/untagged/mismarked row in the set.
 */
import { PrismaClient } from '@prisma/client';
import { PLACEHOLDER_CUSTOMER_NUMBER, PLACEHOLDER_VEHICLE_CODE_PREFIX } from '../../../common/helpers/operational-scope';
import { TEST_CUSTOMER_FIRST_NAME } from './guards';

type Db = PrismaClient;

export const PROTECTED_SYSTEMS = ['SHAREPOINT_CONTACT_DB', 'SHAREPOINT_JOB_SHEET', 'AUTOMATE', 'SAGE'];
/** Shared infra that the cleanup must NEVER delete (defensive — never manifested). */
export const FORBIDDEN_DELETE_TYPES = [
  'Site', 'UserAccount', 'ServiceType', 'WorkResource', 'WorkBay', 'Technician',
  'BusinessRuleConfig', 'ServiceCatalogItem', 'ServiceJobMapping', 'TestDataRun',
];
/** Polymorphic tables — deleted by entityId (point at the deleted entities), not by own id. */
export const POLY_TYPES = ['NotificationLog', 'StatusHistory', 'AuditLog'];

/** FK tables in CHILD → PARENT delete order (each deleted by its own manifested ids). */
export const FK_DELETE_ORDER = [
  'QueueEvent', 'QueueDecision',
  'PartsReservation', 'PartsRequestItem', 'InventoryTransfer', 'PartsRequest',
  'ServiceOrderItem', 'TechnicianAssignment', 'ServiceOrderPause', 'ServiceOrderRework', 'PosReference',
  'MaintenanceReminder', 'MaintenanceRecommendation',
  'AppointmentService', 'ResourceReservation', 'ResourceOccupancy', 'TransportRequest',
  'QueueTicket', 'ServiceOrder',
  'VehicleClassification', 'VehicleSpecSnapshot', 'FluidSpecSnapshot',
  'ServiceVisit', 'Appointment', 'Vehicle', 'Customer',
];

/** Full ordered delete sequence (for documentation + tests). */
export const CLEANUP_DELETE_SEQUENCE = ['NotificationLog', ...FK_DELETE_ORDER, 'StatusHistory', 'AuditLog', 'ExternalSystemRef'];

/** entityType → Prisma model accessor name. */
export const MODEL_BY_TYPE: Record<string, string> = {
  NotificationLog: 'notificationLog', QueueEvent: 'queueEvent', QueueDecision: 'queueDecision',
  PartsReservation: 'partsReservation', PartsRequestItem: 'partsRequestItem', InventoryTransfer: 'inventoryTransfer',
  PartsRequest: 'partsRequest', ServiceOrderItem: 'serviceOrderItem', TechnicianAssignment: 'technicianAssignment',
  ServiceOrderPause: 'serviceOrderPause', ServiceOrderRework: 'serviceOrderRework', PosReference: 'posReference',
  MaintenanceReminder: 'maintenanceReminder', MaintenanceRecommendation: 'maintenanceRecommendation',
  AppointmentService: 'appointmentService', ResourceReservation: 'resourceReservation', ResourceOccupancy: 'resourceOccupancy',
  TransportRequest: 'transportRequest', QueueTicket: 'queueTicket', ServiceOrder: 'serviceOrder',
  VehicleClassification: 'vehicleClassification', VehicleSpecSnapshot: 'vehicleSpecSnapshot', FluidSpecSnapshot: 'fluidSpecSnapshot',
  ServiceVisit: 'serviceVisit', Appointment: 'appointment', Vehicle: 'vehicle', Customer: 'customer',
  StatusHistory: 'statusHistory', AuditLog: 'auditLog',
};

// --- argument guards -------------------------------------------------------
export function assertRunIdProvided(runId: string | undefined): asserts runId is string {
  if (!runId || runId.trim() === '') {
    throw new Error('Refusing: cleanup requires an explicit --run <testDataRunId>.');
  }
}
export function assertBackupProvided(backup: string | undefined): asserts backup is string {
  if (!backup || backup.trim() === '') {
    throw new Error(
      'Refusing: --commit cleanup requires --backup <path-or-acknowledgement>. ' +
        'Take a pg_dump first, then pass its path (recorded in cleanupSummary).',
    );
  }
}

// --- safety (pure) ---------------------------------------------------------
export interface SafetyFacts {
  runExists: boolean;
  status: string | null;
  runType: string | null; // CR-2026-023
  manifestTotal: number;
  historicalVisitsInSet: number;
  placeholderCustomersInSet: number;
  placeholderVehiclesInSet: number;
  protectedSystemRefs: number;
  untaggedAnchors: number;
  nonVwtestCustomers: number;
  sharedInfraTypes: string[];
}
export interface SafetyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Cleanup safety profile. BATCH = scripts/test-data.ts runs (unchanged). */
export type CleanupProfile = 'BATCH' | 'DEV_LOGIN_SESSION';

/**
 * Safety gauntlet. Default profile BATCH is byte-for-byte the original (keeps the
 * non-empty-manifest + firstName=VWTEST checks). The DEV_LOGIN_SESSION profile
 * (CR-2026-023) instead requires runType=DEV_LOGIN_SESSION, drops the VWTEST check
 * (UI-created records have real names) and the non-empty-manifest requirement
 * (zero-child sessions clean to CLEANED_UP), while keeping every protected-data,
 * anchor-tagging, and shared-infra guard.
 */
export function evaluateSafety(f: SafetyFacts, profile: CleanupProfile = 'BATCH'): { pass: boolean; checks: SafetyCheck[] } {
  const checks: SafetyCheck[] = [
    { name: 'run exists', ok: f.runExists, detail: f.runExists ? 'found' : 'run not found' },
    { name: 'status ACTIVE', ok: f.status === 'ACTIVE', detail: `status=${f.status ?? 'n/a'}` },
  ];
  if (profile === 'DEV_LOGIN_SESSION') {
    checks.push({ name: 'runType DEV_LOGIN_SESSION', ok: f.runType === 'DEV_LOGIN_SESSION', detail: `runType=${f.runType ?? 'n/a'}` });
  } else {
    checks.push({ name: 'manifest non-empty', ok: f.manifestTotal > 0, detail: `${f.manifestTotal} refs` });
  }
  checks.push(
    { name: 'no HISTORICAL_IMPORT visits', ok: f.historicalVisitsInSet === 0, detail: `${f.historicalVisitsInSet} in set` },
    { name: 'no placeholder customer', ok: f.placeholderCustomersInSet === 0, detail: `${f.placeholderCustomersInSet} in set` },
    { name: 'no placeholder vehicle', ok: f.placeholderVehiclesInSet === 0, detail: `${f.placeholderVehiclesInSet} in set` },
    { name: 'no protected system refs', ok: f.protectedSystemRefs === 0, detail: `${f.protectedSystemRefs} (${PROTECTED_SYSTEMS.join('/')})` },
    { name: 'all anchors tagged to run', ok: f.untaggedAnchors === 0, detail: `${f.untaggedAnchors} untagged` },
  );
  if (profile === 'BATCH') {
    checks.push({ name: 'all customers firstName=VWTEST', ok: f.nonVwtestCustomers === 0, detail: `${f.nonVwtestCustomers} not VWTEST` });
  }
  checks.push({ name: 'no shared infra in set', ok: f.sharedInfraTypes.length === 0, detail: f.sharedInfraTypes.join(',') || 'none' });
  return { pass: checks.every((c) => c.ok), checks };
}

// --- read-only plan --------------------------------------------------------
export interface CleanupPlan {
  run: { id: string; label: string; status: string; createdByUserId: string; runType: string } | null;
  manifestByType: Record<string, string[]>;
  manifestTotal: number;
  testEntityIds: string[];
  deleteCounts: Record<string, number>;
  totalRows: number;
  facts: SafetyFacts;
}

/** Gather everything needed to preview/guard a cleanup. Performs NO writes. */
export async function loadCleanupPlan(db: Db, runId: string): Promise<CleanupPlan> {
  const run = await db.testDataRun.findUnique({ where: { id: runId } });

  const refs = await db.externalSystemRef.findMany({
    where: { system: 'TEST_DATA_RUN', externalId: runId },
    select: { entityType: true, entityId: true },
  });
  const manifestByType: Record<string, string[]> = {};
  for (const r of refs) (manifestByType[r.entityType] ??= []).push(r.entityId);
  const manifestTotal = refs.length;
  const allEntityIds = refs.map((r) => r.entityId);
  const testEntityIds = refs.filter((r) => !POLY_TYPES.includes(r.entityType)).map((r) => r.entityId);

  // Anchor safety reads
  const customerIds = manifestByType['Customer'] ?? [];
  const vehicleIds = manifestByType['Vehicle'] ?? [];
  const visitIds = manifestByType['ServiceVisit'] ?? [];
  const customers = await db.customer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, customerNumber: true, firstName: true, testDataRunId: true },
  });
  const vehicles = await db.vehicle.findMany({
    where: { id: { in: vehicleIds } },
    select: { id: true, vehicleCode: true, testDataRunId: true },
  });
  const visits = await db.serviceVisit.findMany({
    where: { id: { in: visitIds } },
    select: { id: true, sourceType: true, testDataRunId: true },
  });

  const placeholderCustomersInSet = customers.filter((c) => c.customerNumber === PLACEHOLDER_CUSTOMER_NUMBER).length;
  const placeholderVehiclesInSet = vehicles.filter((v) => v.vehicleCode.startsWith(PLACEHOLDER_VEHICLE_CODE_PREFIX)).length;
  const historicalVisitsInSet = visits.filter((v) => v.sourceType === 'HISTORICAL_IMPORT').length;
  const nonVwtestCustomers = customers.filter((c) => c.firstName !== TEST_CUSTOMER_FIRST_NAME).length;
  const untaggedAnchors =
    customers.filter((c) => c.testDataRunId !== runId).length +
    vehicles.filter((v) => v.testDataRunId !== runId).length +
    visits.filter((v) => v.testDataRunId !== runId).length;

  const protectedSystemRefs = await db.externalSystemRef.count({
    where: { system: { in: PROTECTED_SYSTEMS as any }, entityId: { in: allEntityIds } },
  });
  const sharedInfraTypes = Object.keys(manifestByType).filter((t) => FORBIDDEN_DELETE_TYPES.includes(t));

  // Delete-count preview (exact): FK by manifest length, polymorphic by entityId, refs = manifestTotal.
  const deleteCounts: Record<string, number> = {};
  deleteCounts['NotificationLog'] = await db.notificationLog.count({ where: { entityId: { in: testEntityIds } } });
  for (const type of FK_DELETE_ORDER) deleteCounts[type] = (manifestByType[type] ?? []).length;
  deleteCounts['StatusHistory'] = await db.statusHistory.count({ where: { entityId: { in: testEntityIds } } });
  deleteCounts['AuditLog'] = await db.auditLog.count({ where: { entityId: { in: testEntityIds } } });
  deleteCounts['ExternalSystemRef'] = manifestTotal;
  const totalRows = Object.values(deleteCounts).reduce((a, b) => a + b, 0);

  return {
    run: run ? { id: run.id, label: run.label, status: run.status, createdByUserId: run.createdByUserId, runType: run.runType } : null,
    manifestByType,
    manifestTotal,
    testEntityIds,
    deleteCounts,
    totalRows,
    facts: {
      runExists: !!run,
      status: run?.status ?? null,
      runType: run?.runType ?? null,
      manifestTotal,
      historicalVisitsInSet,
      placeholderCustomersInSet,
      placeholderVehiclesInSet,
      protectedSystemRefs,
      untaggedAnchors,
      nonVwtestCustomers,
      sharedInfraTypes,
    },
  };
}

// --- destructive (transaction) ---------------------------------------------
export interface CleanupResult {
  runId: string;
  label: string;
  counts: Record<string, number>;
  totalDeleted: number;
  backup: string;
}

/**
 * Delete the run's data in dependency order inside ONE transaction, mark the run
 * CLEANED_UP, and write a real (non-test) AuditLog. Re-reads the manifest inside
 * the transaction; re-asserts the run is ACTIVE. Caller MUST have passed safety + backup.
 */
export async function executeCleanup(
  db: Db,
  opts: { runId: string; backup: string; actorUserId: string; auditAction?: string; auditReasonCode?: string },
): Promise<CleanupResult> {
  const auditAction = opts.auditAction ?? 'TEST_DATA_RUN_CLEANED_UP';
  const auditReasonCode = opts.auditReasonCode ?? 'TEST_DATA_CLEANUP';
  return db.$transaction(
    async (tx) => {
      const run = await tx.testDataRun.findUnique({ where: { id: opts.runId } });
      if (!run) throw new Error(`Refusing: TestDataRun ${opts.runId} not found.`);
      if (run.status !== 'ACTIVE') throw new Error(`Refusing: TestDataRun ${opts.runId} is not ACTIVE (status=${run.status}).`);

      const refs = await tx.externalSystemRef.findMany({
        where: { system: 'TEST_DATA_RUN', externalId: opts.runId },
        select: { entityType: true, entityId: true },
      });
      const byType: Record<string, string[]> = {};
      for (const r of refs) (byType[r.entityType] ??= []).push(r.entityId);
      const testEntityIds = refs.filter((r) => !POLY_TYPES.includes(r.entityType)).map((r) => r.entityId);

      const counts: Record<string, number> = {};
      const delById = async (type: string) => {
        const ids = byType[type] ?? [];
        const model = (tx as any)[MODEL_BY_TYPE[type]];
        counts[type] = (await model.deleteMany({ where: { id: { in: ids } } })).count;
      };
      const delByEntityId = async (type: string) => {
        const model = (tx as any)[MODEL_BY_TYPE[type]];
        counts[type] = (await model.deleteMany({ where: { entityId: { in: testEntityIds } } })).count;
      };

      // 1) polymorphic NotificationLog (by entityId)
      await delByEntityId('NotificationLog');
      // 2) FK tables, child → parent (by manifested id)
      for (const type of FK_DELETE_ORDER) await delById(type);
      // 3) polymorphic StatusHistory + AuditLog (by entityId) — after the entities they reference
      await delByEntityId('StatusHistory');
      await delByEntityId('AuditLog');
      // 4) the manifest rows themselves (scoped to THIS run + TEST_DATA_RUN only)
      counts['ExternalSystemRef'] = (
        await tx.externalSystemRef.deleteMany({ where: { system: 'TEST_DATA_RUN', externalId: opts.runId } })
      ).count;

      const totalDeleted = Object.values(counts).reduce((a, b) => a + b, 0);

      await tx.testDataRun.update({
        where: { id: opts.runId },
        data: {
          status: 'CLEANED_UP',
          cleanedAt: new Date(),
          cleanupSummary: { backup: opts.backup, counts, totalDeleted, manifestTotal: refs.length, safety: 'PASS' },
        },
      });

      // Real, non-test audit of the cleanup action (entityId = run id, NOT a deleted entity).
      await tx.auditLog.create({
        data: {
          actorUserId: opts.actorUserId,
          action: auditAction,
          entityType: 'TestDataRun',
          entityId: opts.runId,
          afterJson: { counts, totalDeleted, backup: opts.backup },
          reasonCode: auditReasonCode,
          notes: `Cleaned up test run ${run.label}; backup: ${opts.backup}`,
        },
      });

      return { runId: opts.runId, label: run.label, counts, totalDeleted, backup: opts.backup };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
