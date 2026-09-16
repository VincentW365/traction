import { describe, it, expect, vi } from 'vitest';
import {
  evaluateSafety,
  loadCleanupPlan,
  executeCleanup,
  assertRunIdProvided,
  assertBackupProvided,
  CLEANUP_DELETE_SEQUENCE,
  FK_DELETE_ORDER,
  MODEL_BY_TYPE,
  type SafetyFacts,
} from '../cleanup';

const OK: SafetyFacts = {
  runExists: true, status: 'ACTIVE', runType: 'BATCH', manifestTotal: 7,
  historicalVisitsInSet: 0, placeholderCustomersInSet: 0, placeholderVehiclesInSet: 0,
  protectedSystemRefs: 0, untaggedAnchors: 0, nonVwtestCustomers: 0, sharedInfraTypes: [],
};

describe('evaluateSafety (pure)', () => {
  it('passes when everything is clean', () => {
    const { pass, checks } = evaluateSafety(OK);
    expect(pass).toBe(true);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  const fail: Array<[string, Partial<SafetyFacts>, string]> = [
    ['run missing', { runExists: false, status: null }, 'run exists'],
    ['status not ACTIVE', { status: 'CLEANED_UP' }, 'status ACTIVE'],
    ['empty manifest', { manifestTotal: 0 }, 'manifest non-empty'],
    ['historical visit in set', { historicalVisitsInSet: 1 }, 'no HISTORICAL_IMPORT visits'],
    ['placeholder customer', { placeholderCustomersInSet: 1 }, 'no placeholder customer'],
    ['placeholder vehicle', { placeholderVehiclesInSet: 1 }, 'no placeholder vehicle'],
    ['protected system ref', { protectedSystemRefs: 1 }, 'no protected system refs'],
    ['untagged anchor', { untaggedAnchors: 1 }, 'all anchors tagged to run'],
    ['non-VWTEST customer', { nonVwtestCustomers: 1 }, 'all customers firstName=VWTEST'],
    ['shared infra in set', { sharedInfraTypes: ['UserAccount'] }, 'no shared infra in set'],
  ];
  for (const [name, patch, checkName] of fail) {
    it(`refuses: ${name}`, () => {
      const { pass, checks } = evaluateSafety({ ...OK, ...patch });
      expect(pass).toBe(false);
      expect(checks.find((c) => c.name === checkName)?.ok).toBe(false);
    });
  }

  it('BATCH (default) still requires firstName=VWTEST', () => {
    const r = evaluateSafety({ ...OK, nonVwtestCustomers: 1 }, 'BATCH');
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'all customers firstName=VWTEST')?.ok).toBe(false);
  });
});

describe('evaluateSafety — DEV_LOGIN_SESSION profile (CR-2026-023)', () => {
  const DEV: SafetyFacts = { ...OK, runType: 'DEV_LOGIN_SESSION' };

  it('passes with real (non-VWTEST) names + zero manifest', () => {
    const r = evaluateSafety({ ...DEV, nonVwtestCustomers: 3, manifestTotal: 0 }, 'DEV_LOGIN_SESSION');
    expect(r.pass).toBe(true);
    expect(r.checks.some((c) => c.name === 'all customers firstName=VWTEST')).toBe(false); // no VWTEST check
    expect(r.checks.some((c) => c.name === 'manifest non-empty')).toBe(false); // empty allowed
    expect(r.checks.find((c) => c.name === 'runType DEV_LOGIN_SESSION')?.ok).toBe(true);
  });

  it('refuses a non-DEV_LOGIN_SESSION run under this profile', () => {
    const r = evaluateSafety({ ...DEV, runType: 'BATCH' }, 'DEV_LOGIN_SESSION');
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'runType DEV_LOGIN_SESSION')?.ok).toBe(false);
  });

  it('still refuses historical / placeholder / protected / untagged / shared-infra', () => {
    for (const patch of [
      { historicalVisitsInSet: 1 }, { placeholderCustomersInSet: 1 }, { placeholderVehiclesInSet: 1 },
      { protectedSystemRefs: 1 }, { untaggedAnchors: 1 }, { sharedInfraTypes: ['UserAccount'] },
    ] as Partial<SafetyFacts>[]) {
      expect(evaluateSafety({ ...DEV, ...patch }, 'DEV_LOGIN_SESSION').pass).toBe(false);
    }
  });
});

describe('delete sequence (dependency order)', () => {
  const i = (t: string) => CLEANUP_DELETE_SEQUENCE.indexOf(t);
  it('children precede parents; polymorphic + manifest refs last', () => {
    expect(i('NotificationLog')).toBe(0);
    expect(i('ServiceOrderItem')).toBeLessThan(i('ServiceOrder'));
    expect(i('TechnicianAssignment')).toBeLessThan(i('ServiceOrder'));
    expect(i('QueueEvent')).toBeLessThan(i('QueueTicket'));
    expect(i('QueueTicket')).toBeLessThan(i('ServiceVisit'));
    expect(i('TransportRequest')).toBeLessThan(i('ServiceVisit'));
    expect(i('AppointmentService')).toBeLessThan(i('Appointment'));
    expect(i('ServiceOrder')).toBeLessThan(i('ServiceVisit'));
    expect(i('ServiceVisit')).toBeLessThan(i('Appointment'));
    expect(i('Appointment')).toBeLessThan(i('Vehicle'));
    expect(i('VehicleClassification')).toBeLessThan(i('Vehicle'));
    expect(i('Vehicle')).toBeLessThan(i('Customer'));
    expect(i('Customer')).toBeLessThan(i('StatusHistory'));
    expect(i('StatusHistory')).toBeLessThan(i('AuditLog'));
    expect(i('AuditLog')).toBeLessThan(i('ExternalSystemRef'));
    expect(CLEANUP_DELETE_SEQUENCE[CLEANUP_DELETE_SEQUENCE.length - 1]).toBe('ExternalSystemRef');
  });
});

describe('argument guards', () => {
  it('missing --run refuses', () => {
    expect(() => assertRunIdProvided(undefined)).toThrow(/explicit --run/);
    expect(() => assertRunIdProvided('')).toThrow(/explicit --run/);
    expect(() => assertRunIdProvided('run-1')).not.toThrow();
  });
  it('commit without backup refuses', () => {
    expect(() => assertBackupProvided(undefined)).toThrow(/--backup/);
    expect(() => assertBackupProvided('')).toThrow(/--backup/);
    expect(() => assertBackupProvided('/tmp/backup.sql')).not.toThrow();
  });
});

function planPrisma(over: Record<string, any> = {}): any {
  const boom = vi.fn(async () => {
    throw new Error('UNEXPECTED WRITE');
  });
  return {
    testDataRun: {
      findUnique: vi.fn(async () => ({ id: 'run-1', label: 'lbl', status: 'ACTIVE', createdByUserId: 'u1' })),
      update: boom,
    },
    externalSystemRef: {
      findMany: vi.fn(async () => [
        { entityType: 'Customer', entityId: 'c1' },
        { entityType: 'Vehicle', entityId: 'v1' },
        { entityType: 'ServiceVisit', entityId: 'sv1' },
        { entityType: 'QueueTicket', entityId: 'qt1' },
        { entityType: 'StatusHistory', entityId: 'sh1' },
        { entityType: 'StatusHistory', entityId: 'sh2' },
        { entityType: 'AuditLog', entityId: 'al1' },
      ]),
      count: vi.fn(async () => 0),
      deleteMany: boom,
    },
    customer: {
      findMany: vi.fn(async () => [{ id: 'c1', customerNumber: 'CUST-000001', firstName: 'VWTEST', testDataRunId: 'run-1' }]),
      deleteMany: boom,
    },
    vehicle: { findMany: vi.fn(async () => [{ id: 'v1', vehicleCode: 'SC-VWT-x', testDataRunId: 'run-1' }]), deleteMany: boom },
    serviceVisit: { findMany: vi.fn(async () => [{ id: 'sv1', sourceType: 'WALKIN', testDataRunId: 'run-1' }]), deleteMany: boom },
    notificationLog: { count: vi.fn(async () => 0), deleteMany: boom },
    statusHistory: { count: vi.fn(async () => 2), deleteMany: boom },
    auditLog: { count: vi.fn(async () => 1), deleteMany: boom, create: boom },
    $transaction: vi.fn(async () => {
      throw new Error('UNEXPECTED $transaction');
    }),
    ...over,
  };
}

describe('loadCleanupPlan (dry-run) — reads only, no deletes', () => {
  it('computes exact delete counts + safety facts without any write', async () => {
    const prisma = planPrisma();
    const plan = await loadCleanupPlan(prisma, 'run-1');

    expect(plan.manifestTotal).toBe(7);
    expect(plan.testEntityIds).toEqual(['c1', 'v1', 'sv1', 'qt1']); // poly excluded
    expect(plan.deleteCounts).toMatchObject({
      Customer: 1, Vehicle: 1, ServiceVisit: 1, QueueTicket: 1,
      StatusHistory: 2, AuditLog: 1, NotificationLog: 0, ExternalSystemRef: 7,
    });
    expect(plan.totalRows).toBe(14);
    expect(evaluateSafety(plan.facts).pass).toBe(true);

    // No writes touched
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.customer.deleteMany).not.toHaveBeenCalled();
    expect(prisma.externalSystemRef.deleteMany).not.toHaveBeenCalled();
    expect(prisma.testDataRun.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('surfaces a protected (historical) visit as a safety FAIL', async () => {
    const prisma = planPrisma({
      serviceVisit: { findMany: vi.fn(async () => [{ id: 'sv1', sourceType: 'HISTORICAL_IMPORT', testDataRunId: 'run-1' }]) },
    });
    const plan = await loadCleanupPlan(prisma, 'run-1');
    expect(plan.facts.historicalVisitsInSet).toBe(1);
    expect(evaluateSafety(plan.facts).pass).toBe(false);
  });
});

function execTx(order: string[]): any {
  const tx: any = {
    testDataRun: {
      findUnique: vi.fn(async () => ({ id: 'run-1', label: 'lbl', status: 'ACTIVE', createdByUserId: 'u1' })),
      update: vi.fn(async () => ({})),
    },
    externalSystemRef: {
      findMany: vi.fn(async () => [
        { entityType: 'Customer', entityId: 'c1' },
        { entityType: 'Vehicle', entityId: 'v1' },
        { entityType: 'ServiceVisit', entityId: 'sv1' },
        { entityType: 'QueueTicket', entityId: 'qt1' },
        { entityType: 'StatusHistory', entityId: 'sh1' },
        { entityType: 'AuditLog', entityId: 'al1' },
      ]),
      deleteMany: vi.fn(async () => {
        order.push('ExternalSystemRef');
        return { count: 6 };
      }),
    },
    notificationLog: { deleteMany: vi.fn(async () => { order.push('NotificationLog'); return { count: 0 }; }) },
    statusHistory: { deleteMany: vi.fn(async () => { order.push('StatusHistory'); return { count: 1 }; }) },
    auditLog: {
      deleteMany: vi.fn(async () => { order.push('AuditLog'); return { count: 1 }; }),
      create: vi.fn(async () => ({ id: 'cleanup-audit' })),
    },
    // CR-2026-053 — inspections cleared off the run's visits before parents.
    vehicleInspection: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  for (const type of FK_DELETE_ORDER) {
    tx[MODEL_BY_TYPE[type]] = { deleteMany: vi.fn(async () => { order.push(type); return { count: 1 }; }) };
  }
  return tx;
}

describe('executeCleanup — deletes in order, marks CLEANED_UP, audits', () => {
  it('runs the full sequence and updates the run', async () => {
    const order: string[] = [];
    const tx = execTx(order);
    const db: any = { $transaction: async (cb: any) => cb(tx) };

    const result = await executeCleanup(db, { runId: 'run-1', backup: '/tmp/backup.sql', actorUserId: 'u1' });

    // order: NotificationLog first, ExternalSystemRef last; child→parent honored
    expect(order[0]).toBe('NotificationLog');
    expect(order[order.length - 1]).toBe('ExternalSystemRef');
    expect(order.indexOf('ServiceOrder')).toBeLessThan(order.indexOf('ServiceVisit'));
    expect(order.indexOf('ServiceVisit')).toBeLessThan(order.indexOf('Appointment'));
    expect(order.indexOf('Vehicle')).toBeLessThan(order.indexOf('Customer'));
    expect(order.indexOf('Customer')).toBeLessThan(order.indexOf('StatusHistory'));
    expect(order.indexOf('StatusHistory')).toBeLessThan(order.indexOf('AuditLog'));

    // run marked CLEANED_UP with backup recorded
    const upd = tx.testDataRun.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'run-1' });
    expect(upd.data.status).toBe('CLEANED_UP');
    expect(upd.data.cleanedAt).toBeInstanceOf(Date);
    expect(upd.data.cleanupSummary.backup).toBe('/tmp/backup.sql');

    // real cleanup audit written (non-test; entityId = run id)
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('TEST_DATA_RUN_CLEANED_UP');
    expect(audit.entityType).toBe('TestDataRun');
    expect(audit.entityId).toBe('run-1');

    expect(result.runId).toBe('run-1');
    expect(result.backup).toBe('/tmp/backup.sql');
    expect(result.totalDeleted).toBeGreaterThan(0);
  });

  it('refuses if the run is no longer ACTIVE (race guard inside tx)', async () => {
    const tx: any = {
      testDataRun: { findUnique: vi.fn(async () => ({ id: 'run-1', label: 'lbl', status: 'CLEANED_UP', createdByUserId: 'u1' })) },
    };
    const db: any = { $transaction: async (cb: any) => cb(tx) };
    await expect(executeCleanup(db, { runId: 'run-1', backup: '/b', actorUserId: 'u1' })).rejects.toThrow(/not ACTIVE/);
  });
});

/**
 * CR-2026-108 §5 — a test run must not leave captured notification bodies and
 * recipient addresses behind after its data is removed. A CAPTURED row holds the
 * full rendered message and the real address it would have gone to, so it is
 * exactly the kind of residue that must go with the run.
 *
 * No schema change was needed: NotificationLog is polymorphic on entityId, the
 * manifest collects it over every id the run created (including the run's
 * Appointments), and it is deleted FIRST in the sequence. These assertions pin
 * that so the guarantee cannot be removed without failing here.
 */
describe('CR-2026-108 — captured notifications participate in test-run cleanup', () => {
  it('NotificationLog is deleted, and deleted before the rows it points at', () => {
    expect(CLEANUP_DELETE_SEQUENCE).toContain('NotificationLog');
    expect(CLEANUP_DELETE_SEQUENCE.indexOf('NotificationLog')).toBeLessThan(
      CLEANUP_DELETE_SEQUENCE.indexOf('Appointment'),
    );
    expect(CLEANUP_DELETE_SEQUENCE.indexOf('NotificationLog')).toBeLessThan(
      CLEANUP_DELETE_SEQUENCE.indexOf('Customer'),
    );
  });

  it('maps to a real Prisma model so the delete can actually run', () => {
    expect(MODEL_BY_TYPE.NotificationLog).toBe('notificationLog');
  });

  /**
   * A captured booking message carries entityType 'Appointment'. Appointments are
   * collected from the run's customers, and NotificationLog is collected over all
   * collected ids — so the capture is reachable. This guards the chain by source,
   * because breaking any link would silently orphan customer message content.
   */
  it('the manifest reaches an Appointment-scoped notification', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const manifestSrc = fs.readFileSync(path.join(__dirname, '..', 'manifest.ts'), 'utf8');
    // Appointments come from the run's customers...
    expect(manifestSrc).toMatch(/appointment\.findMany\(\{\s*where:\s*\{\s*customerId:\s*\{\s*in:\s*customerIds/);
    // ...and notifications are collected over every id the run created.
    expect(manifestSrc).toMatch(/notificationLog\.findMany\(\{\s*where:\s*\{\s*entityId:\s*\{\s*in:\s*allIds/);
  });
});
