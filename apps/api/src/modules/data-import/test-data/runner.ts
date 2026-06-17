/**
 * Test Data Sandbox — runner (CR-2026-020, T-b).
 *
 * Orchestration shared by the CLI: read-only infra loading, the dry-run planner
 * (NO writes), the commit path (one transaction: TestDataRun → scenarios →
 * manifest → completeness check), and `list`. Kept importable for unit tests.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { assertLabelAvailable } from './guards';
import {
  ManifestRecorder,
  writeManifest,
  collectRunFootprint,
  diffManifest,
  ManifestIncompleteError,
} from './manifest';
import {
  SCENARIOS,
  RunAllocator,
  summarizePlans,
  expandScenarioKeys,
  type TestInfra,
  type ScenarioContext,
  type ScenarioPlan,
} from './scenarios';

type Db = PrismaClient;

export interface InfraResult {
  infra: TestInfra;
  warnings: string[];
}

/** Resolve the shared infra a run needs (Site, user, technician, bay, service types). Read-only. */
export async function loadInfra(
  db: Db,
  opts: { defaultSiteCode: string; needTransport: boolean },
): Promise<InfraResult> {
  const warnings: string[] = [];

  const site =
    (await db.site.findUnique({ where: { code: opts.defaultSiteCode } })) ??
    (await db.site.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } }));
  if (!site) throw new Error('No Site found — cannot create test data.');

  const advisor =
    (await db.userAccount.findFirst({
      where: { status: 'ACTIVE', roleCode: { in: ['ADMIN', 'SERVICE_ADVISOR'] } },
      orderBy: { createdAt: 'asc' },
    })) ?? (await db.userAccount.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }));
  if (!advisor) throw new Error('No active UserAccount found — needed for createdBy/actor references.');

  const technician = await db.technician.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  if (!technician) throw new Error('No active Technician found — needed for the completed scenario.');

  const bay =
    (await db.workBay.findFirst({ where: { status: 'ACTIVE', bayType: 'GENERAL' }, orderBy: { code: 'asc' } })) ??
    (await db.workBay.findFirst({ where: { status: 'ACTIVE' }, orderBy: { code: 'asc' } }));
  if (!bay) throw new Error('No active WorkBay found — needed for the completed scenario.');

  const generalSvc = await db.serviceType.findFirst({
    where: { isActive: true, appointmentOnly: false },
    orderBy: { baseDurationMinutes: 'asc' },
  });
  if (!generalSvc) throw new Error('No active ServiceType found.');

  let transportServiceTypeId: string | undefined;
  if (opts.needTransport) {
    const t = await db.serviceType.findFirst({ where: { isActive: true, transportEligible: true } });
    if (t) transportServiceTypeId = t.id;
    else warnings.push('No transport-eligible ServiceType found — the transport scenario is unavailable.');
  }

  return {
    infra: {
      siteId: site.id,
      advisorUserId: advisor.id,
      technicianId: technician.id,
      bayId: bay.id,
      generalServiceTypeId: generalSvc.id,
      generalServiceTypeDuration: generalSvc.baseDurationMinutes,
      transportServiceTypeId,
    },
    warnings,
  };
}

/** Next CUST- sequence number, computed over CUST-<digits> rows ONLY (ignores imported C- numbers). */
export async function nextCustomerSeqStart(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ max: number | bigint | null }>>(Prisma.sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(customer_number FROM 6) AS INTEGER)), 0) AS max
    FROM customers
    WHERE customer_number ~ '^CUST-[0-9]+$'`);
  const max = rows[0]?.max ?? 0;
  return Number(max) + 1;
}

export interface DryRunResult {
  allowEnabled: boolean;
  repeat: number;
  requestedKeys: string[];
  effectiveKeys: string[];
  warnings: string[];
  summary: ReturnType<typeof summarizePlans>;
}

/** Dry-run: read infra, compute what WOULD be created. Performs NO writes. */
export async function planRun(
  db: Db,
  opts: { defaultSiteCode: string; scenarioKeys: string[]; repeat: number; allowEnabled: boolean },
): Promise<DryRunResult> {
  const needTransport = opts.scenarioKeys.includes('transport');
  const { infra, warnings } = await loadInfra(db, { defaultSiteCode: opts.defaultSiteCode, needTransport });

  let effectiveKeys = opts.scenarioKeys;
  if (needTransport && !infra.transportServiceTypeId) {
    effectiveKeys = opts.scenarioKeys.filter((k) => k !== 'transport');
    warnings.push('transport scenario will be SKIPPED (no transport-eligible ServiceType).');
  }

  return {
    allowEnabled: opts.allowEnabled,
    repeat: opts.repeat,
    requestedKeys: opts.scenarioKeys,
    effectiveKeys,
    warnings,
    summary: summarizePlans(effectiveKeys, opts.repeat),
  };
}

export interface CreateRunResult {
  runId: string;
  label: string;
  counts: ScenarioPlan;
  manifestEntries: number;
  footprintEntries: number;
  extra: number;
  executed: string[];
}

/** Commit: create the run + tagged data + manifest inside ONE transaction; abort on any anomaly. */
export async function createRun(
  db: Db,
  opts: { defaultSiteCode: string; label: string; scenarioKeys: string[]; repeat: number; notes?: string },
): Promise<CreateRunResult> {
  const needTransport = opts.scenarioKeys.includes('transport');
  const { infra } = await loadInfra(db, { defaultSiteCode: opts.defaultSiteCode, needTransport });
  if (needTransport && !infra.transportServiceTypeId) {
    throw new Error('transport scenario requested but no transport-eligible ServiceType exists.');
  }

  const existing = await db.testDataRun.findUnique({ where: { label: opts.label } });
  assertLabelAvailable(existing, opts.label);

  return db.$transaction(
    async (tx) => {
      const run = await tx.testDataRun.create({
        data: {
          label: opts.label,
          createdByUserId: infra.advisorUserId,
          notes: opts.notes ?? null,
          status: 'ACTIVE',
          runType: 'BATCH', // CR-2026-023 — explicit (default is also BATCH)
        },
      });
      const rec = new ManifestRecorder();
      const alloc = new RunAllocator(await nextCustomerSeqStart(tx));
      const ctx: ScenarioContext = {
        ...infra,
        runId: run.id,
        label: opts.label,
        runShort: run.id.replace(/-/g, '').slice(0, 8),
      };

      const executed = expandScenarioKeys(opts.scenarioKeys, opts.repeat);
      for (const k of executed) await SCENARIOS[k].run(tx, ctx, rec, alloc);

      const manifestEntries = await writeManifest(tx, run.id, opts.label, rec.entries);

      // Independently re-derive the run's footprint and PROVE the manifest is complete.
      const footprint = await collectRunFootprint(tx, run.id);
      const { missing, extra } = diffManifest(footprint.entries, rec.entries);
      if (missing.length) throw new ManifestIncompleteError(missing);

      const counts = rec.countsByTable();
      await tx.testDataRun.update({
        where: { id: run.id },
        data: {
          creationSummary: {
            scenarios: executed,
            repeat: opts.repeat,
            counts,
            manifestEntries,
            footprintEntries: footprint.entries.length,
            extra: extra.length,
          },
        },
      });

      return {
        runId: run.id,
        label: opts.label,
        counts,
        manifestEntries,
        footprintEntries: footprint.entries.length,
        extra: extra.length,
        executed,
      };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

export interface RunListItem {
  id: string;
  label: string;
  status: string;
  createdAt: Date;
  createdByUserId: string;
  notes: string | null;
  manifestCount: number;
}

/** List all test runs with their manifest sizes. Read-only. */
export async function listRuns(db: Db): Promise<RunListItem[]> {
  const runs = await db.testDataRun.findMany({ orderBy: { createdAt: 'desc' } });
  const out: RunListItem[] = [];
  for (const r of runs) {
    const manifestCount = await db.externalSystemRef.count({
      where: { system: 'TEST_DATA_RUN', externalId: r.id },
    });
    out.push({
      id: r.id,
      label: r.label,
      status: r.status,
      createdAt: r.createdAt,
      createdByUserId: r.createdByUserId,
      notes: r.notes,
      manifestCount,
    });
  }
  return out;
}
