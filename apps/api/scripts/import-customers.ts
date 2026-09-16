/**
 * Customer + Vehicle importer (CR-2026-003; reconciliation CR-2026-106).
 *
 * Modes:
 *   (default)            DRY-RUN — reads CSV, plans, writes report to demo-output/. NO DB writes.
 *   --reconcile          Reads CSV, plans, and compares the plan with the DATABASE by stable keys
 *                        (customer number / vehicle code / phone / email / plate / VIN — never names).
 *                        Prints the reconciliation table (source rows = parsed + dropped;
 *                        planned = present + matched + would-create + review), writes the
 *                        exceptions CSV, records an ImportRun. NO customer/vehicle writes.
 *   --commit             Idempotent write into Customer/Vehicle (+ ExternalSystemRef for BOTH the
 *                        customer and the vehicle). Records an ImportRun with the post-commit
 *                        reconciliation so "Import Complete" is a checked statement.
 *   --rollback <batchId> Delete a previously committed batch.
 *   --file <path>        CSV path (default: ./customers.csv)
 *   --actor <label>      Who ran it (stored on ImportRun; optional)
 *
 * Guardrails: customers + vehicles ONLY (no jobs/visits). Imported contacts get
 * notification opt-in = FALSE (no proven consent). Real PII stays in git-ignored
 * customers.csv + demo-output/. Run with VIN_DECODE_PROVIDER=STUB (no outbound calls).
 *
 *   pnpm customers:import -- --file customers.csv              # dry-run
 *   pnpm customers:reconcile -- --file customers.csv           # compare with the target DB
 *   pnpm customers:import:commit -- --file customers.csv       # write (after review)
 *   tsx apps/api/scripts/import-customers.ts --rollback <batchId>
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  rawRowFromCsv,
  planImport,
  buildDryRunReport,
  type ImportPlan,
} from '../src/modules/data-import/customer-vehicle.mapper';
import {
  buildReconciliation,
  exceptionsCsv,
  reconciliationTotals,
  renderReconciliationMarkdown,
  type DbCustomerLookup,
  type DbVehicleLookup,
  type ReconciliationReport,
  type SourceCounts,
} from '../src/modules/data-import/reconcile';

const SYSTEM = 'SHAREPOINT_CONTACT_DB' as const;
const OUT_DIR = 'demo-output';

// --- args ---
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const MODE = has('--rollback') ? 'rollback' : has('--commit') ? 'commit' : has('--reconcile') ? 'reconcile' : 'dry-run';
const FILE = val('--file') ?? 'customers.csv';
const ROLLBACK_ID = val('--rollback');
const ACTOR = val('--actor') ?? process.env.USERNAME ?? process.env.USER ?? null;

/** Host/db of DATABASE_URL without credentials — for the report header and ImportRun. */
function databaseLabel(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? '');
    return `${u.hostname}${u.pathname}`;
  } catch {
    return 'unknown';
  }
}

// --- minimal CSV parser (quoted fields, embedded commas/newlines) ---
// CR-2026-106 — returns the rows it DROPPED too, so the reconciliation can prove
// nothing vanished silently between the file and the plan.
function parseCsv(s: string): { records: Record<string, string>[]; dataLines: number; droppedShortRows: number } {
  const rows: string[][] = [];
  let f: string[] = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { f.push(cur); cur = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { f.push(cur); rows.push(f); f = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || f.length) { f.push(cur); rows.push(f); }
  const header = rows[0];
  const data = rows.slice(1);
  const kept = data.filter((r) => r.length >= header.length - 3 && r.some((x) => x !== ''));
  return {
    records: kept.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))),
    dataLines: data.length,
    droppedShortRows: data.length - kept.length,
  };
}

function loadPlan(): { plan: ImportPlan; source: SourceCounts } {
  const parsed = parseCsv(readFileSync(FILE, 'utf8'));
  const withId = parsed.records.filter((r) => (r['Id'] ?? '').trim());
  const rows = withId.map(rawRowFromCsv);
  return {
    plan: planImport(rows),
    source: {
      rowsInFile: parsed.dataLines,
      parsed: parsed.records.length,
      droppedShortRows: parsed.droppedShortRows,
      droppedNoId: parsed.records.length - withId.length,
    },
  };
}

// ---------------------------------------------------------------------------
// DRY-RUN
// ---------------------------------------------------------------------------
function dryRun() {
  const { plan, source } = loadPlan();
  const c = plan.counts;
  mkdirSync(OUT_DIR, { recursive: true });

  const { summary, flaggedCsv } = buildDryRunReport(plan, FILE);
  writeFileSync(join(OUT_DIR, 'import-dryrun-summary.md'), summary, 'utf8');
  writeFileSync(join(OUT_DIR, 'import-flagged-rows.csv'), flaggedCsv, 'utf8');

  const cov = (n: number, d: number) => `${n}/${d}`;
  console.warn(`\nDRY-RUN complete — NO DB writes.`);
  console.warn(`  file rows=${source.rowsInFile}  parsed=${source.parsed}  dropped(short)=${source.droppedShortRows}  dropped(no Id)=${source.droppedNoId}`);
  console.warn(`  planned rows=${c.rowsRead}  customers=${c.customersToCreate}  vehicles=${c.vehiclesToCreate}  ` +
    `dupPlates=${c.duplicatePlates}  suspiciousMerges=${c.suspiciousMerges}  flagged=${plan.flagged.length}`);
  console.warn(`  coverage — loyalty:${cov(plan.customers.filter((x) => x.loyaltyNumber).length, plan.customers.length)} ` +
    `fuel:${cov(plan.vehicles.filter((v) => v.fuelType).length, plan.vehicles.length)} ` +
    `transmission:${cov(plan.vehicles.filter((v) => v.transmission).length, plan.vehicles.length)} ` +
    `drivetrain:${cov(plan.vehicles.filter((v) => v.drivetrain).length, plan.vehicles.length)} ` +
    `engine_no:${cov(plan.vehicles.filter((v) => v.engineNo).length, plan.vehicles.length)} (engine redacted)`);
  console.warn(`  report -> ${OUT_DIR}/import-dryrun-summary.md  (+ import-flagged-rows.csv)\n`);
}

// ---------------------------------------------------------------------------
// RECONCILE (CR-2026-106) — compare the plan with the target database by STABLE keys
// ---------------------------------------------------------------------------
async function lookups(prisma: PrismaClient, plan: ImportPlan): Promise<{ customers: DbCustomerLookup; vehicles: DbVehicleLookup }> {
  const customerNumbers = plan.customers.map((c) => c.customerNumber);
  const phones = [...new Set(plan.customers.map((c) => c.phone.replace(/\D/g, '')).filter((p) => p.length >= 7))];
  const emails = [...new Set(plan.customers.map((c) => (c.email ?? '').trim().toLowerCase()).filter(Boolean))];
  const names = [...new Set(plan.customers.map((c) => `${c.firstName} ${c.lastName}`.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean))];
  const vehicleCodes = plan.vehicles.map((v) => v.vehicleCode);
  const plates = [...new Set(plan.vehicles.map((v) => v.plateNumber).filter((p): p is string => !!p))];
  const vins = [...new Set(plan.vehicles.map((v) => v.vin).filter((p): p is string => !!p))];

  const chunk = <T>(arr: T[], n = 2000): T[][] => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  const byCustomerNumber = new Set<string>();
  const byPhone = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const part of chunk(customerNumbers)) {
    for (const r of await prisma.customer.findMany({ where: { customerNumber: { in: part } }, select: { customerNumber: true } })) byCustomerNumber.add(r.customerNumber);
  }
  for (const part of chunk(phones)) {
    for (const r of await prisma.customer.findMany({ where: { phone: { in: part }, testDataRunId: null }, select: { customerNumber: true, phone: true } })) {
      byPhone.set(r.phone, [...(byPhone.get(r.phone) ?? []), r.customerNumber]);
    }
  }
  for (const part of chunk(emails)) {
    for (const r of await prisma.customer.findMany({ where: { email: { in: part, mode: 'insensitive' }, testDataRunId: null }, select: { customerNumber: true, email: true } })) {
      const k = (r.email ?? '').toLowerCase();
      byEmail.set(k, [...(byEmail.get(k) ?? []), r.customerNumber]);
    }
  }
  // Names: only to RAISE review/name-only exceptions — never to match.
  for (const part of chunk(names, 500)) {
    const rows = await prisma.$queryRawUnsafe<Array<{ customer_number: string; name_key: string }>>(
      `SELECT customer_number, lower(regexp_replace(trim(first_name || ' ' || last_name), '\\s+', ' ', 'g')) AS name_key
       FROM customers WHERE test_data_run_id IS NULL AND lower(regexp_replace(trim(first_name || ' ' || last_name), '\\s+', ' ', 'g')) = ANY($1::text[])`,
      part,
    );
    for (const r of rows) byName.set(r.name_key, [...(byName.get(r.name_key) ?? []), r.customer_number]);
  }

  const byVehicleCode = new Set<string>();
  const byPlate = new Map<string, string[]>();
  const byVin = new Map<string, string[]>();
  for (const part of chunk(vehicleCodes)) {
    for (const r of await prisma.vehicle.findMany({ where: { vehicleCode: { in: part } }, select: { vehicleCode: true } })) byVehicleCode.add(r.vehicleCode);
  }
  for (const part of chunk(plates)) {
    for (const r of await prisma.vehicle.findMany({ where: { plateNumber: { in: part } }, select: { vehicleCode: true, plateNumber: true } })) {
      byPlate.set(r.plateNumber, [...(byPlate.get(r.plateNumber) ?? []), r.vehicleCode]);
    }
  }
  for (const part of chunk(vins)) {
    for (const r of await prisma.vehicle.findMany({ where: { vin: { in: part } }, select: { vehicleCode: true, vin: true } })) {
      if (r.vin) byVin.set(r.vin, [...(byVin.get(r.vin) ?? []), r.vehicleCode]);
    }
  }
  return { customers: { byCustomerNumber, byPhone, byEmail, byName }, vehicles: { byVehicleCode, byPlate, byVin } };
}

async function reconcileAgainstDb(prisma: PrismaClient, plan: ImportPlan, source: SourceCounts): Promise<ReconciliationReport> {
  const l = await lookups(prisma, plan);
  return buildReconciliation(source, plan, l.customers, l.vehicles);
}

async function recordRun(prisma: PrismaClient, mode: string, startedAt: Date, report: ReconciliationReport, batchId: string | null) {
  await prisma.importRun.create({
    data: {
      system: SYSTEM,
      mode,
      sourceFile: basename(FILE),
      batchId,
      startedAt,
      finishedAt: new Date(),
      totals: reconciliationTotals(report) as never,
      exceptionsCount: report.exceptions.length,
      reconciles: report.source.reconciles && report.customers.reconciles && report.vehicles.reconciles,
      actor: ACTOR,
      databaseLabel: databaseLabel(),
    },
  });
}

function writeReconciliation(report: ReconciliationReport, mode: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  const md = renderReconciliationMarkdown(report, { sourceFile: FILE, database: databaseLabel(), mode });
  writeFileSync(join(OUT_DIR, 'import-reconciliation.md'), md, 'utf8');
  writeFileSync(join(OUT_DIR, 'import-exceptions.csv'), exceptionsCsv(report), 'utf8');
  console.warn(md);
  console.warn(`  exceptions (detail, git-ignored) -> ${OUT_DIR}/import-exceptions.csv\n`);
}

async function reconcile() {
  const prisma = new PrismaClient();
  const startedAt = new Date();
  try {
    const { plan, source } = loadPlan();
    const report = await reconcileAgainstDb(prisma, plan, source);
    writeReconciliation(report, 'RECONCILE');
    await recordRun(prisma, 'RECONCILE', startedAt, report, null);
    if (!(report.source.reconciles && report.customers.reconciles && report.vehicles.reconciles)) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// COMMIT (idempotent, batch-tagged) — NOT run until dry-run is approved
// ---------------------------------------------------------------------------
async function commit() {
  const prisma = new PrismaClient();
  const startedAt = new Date();
  const { plan, source } = loadPlan();
  const batchId = randomUUID();
  let customersWritten = 0, vehiclesWritten = 0;

  try {
    const customerIdByNumber = new Map<string, string>();
    for (const cu of plan.customers) {
      const note = `import:${batchId}; raw="${cu.rawName}"`;
      const rec = await prisma.customer.upsert({
        where: { customerNumber: cu.customerNumber },
        update: { firstName: cu.firstName, lastName: cu.lastName, phone: cu.phone, email: cu.email ?? undefined, loyaltyNumber: cu.loyaltyNumber ?? undefined, loyaltyMember: !!cu.loyaltyNumber?.trim() },
        create: {
          customerNumber: cu.customerNumber, firstName: cu.firstName, lastName: cu.lastName,
          phone: cu.phone, email: cu.email ?? undefined, loyaltyNumber: cu.loyaltyNumber ?? undefined, loyaltyMember: !!cu.loyaltyNumber?.trim(),
          notificationOptInSms: false, notificationOptInEmail: false, // no proven consent
          notes: note,
        },
      });
      customerIdByNumber.set(cu.customerNumber, rec.id);
      // CR-2026-106 — customer-level provenance by STABLE source key (the SharePoint
      // contact ids that formed this customer), not only a note string.
      await upsertRef(prisma, 'Customer', rec.id, cu.vehicleContactIds[0] ?? cu.dedupeKey, batchId, { contactIds: cu.vehicleContactIds, dedupeKey: cu.dedupeKey });
      customersWritten++;
    }

    for (const v of plan.vehicles) {
      const customerId = customerIdByNumber.get(v.customerNumber)!;
      let vehicleId: string;
      try {
        const rec = await prisma.vehicle.upsert({
          where: { vehicleCode: v.vehicleCode },
          update: { customerId, plateNumber: v.plateNumber ?? '', make: v.make, model: v.model, modelYear: v.modelYear, fuelType: v.fuelType, transmission: v.transmission, drivetrain: v.drivetrain, engineNo: v.engineNo },
          create: {
            customerId, vehicleCode: v.vehicleCode, plateNumber: v.plateNumber ?? '',
            vin: v.vin ?? undefined, make: v.make, model: v.model, modelYear: v.modelYear,
            fuelType: v.fuelType, transmission: v.transmission, drivetrain: v.drivetrain, engineNo: v.engineNo,
            // NOTE: Vehicle has no `notes` field — batch tag lives on ExternalSystemRef.metadata.
          },
        });
        vehicleId = rec.id;
      } catch {
        // unique collision (e.g. VIN already in DB) → retry without vin
        const rec = await prisma.vehicle.upsert({
          where: { vehicleCode: v.vehicleCode },
          update: { customerId, plateNumber: v.plateNumber ?? '', make: v.make, model: v.model, modelYear: v.modelYear, fuelType: v.fuelType, transmission: v.transmission, drivetrain: v.drivetrain, engineNo: v.engineNo },
          create: { customerId, vehicleCode: v.vehicleCode, plateNumber: v.plateNumber ?? '', make: v.make, model: v.model, modelYear: v.modelYear, fuelType: v.fuelType, transmission: v.transmission, drivetrain: v.drivetrain, engineNo: v.engineNo },
        });
        vehicleId = rec.id;
      }
      await upsertRef(prisma, 'Vehicle', vehicleId, v.contactId, batchId, { contactId: v.contactId });
      vehiclesWritten++;
    }

    console.warn(`\nCOMMIT complete (batch ${batchId}):`);
    console.warn(`  customers=${customersWritten}  vehicles=${vehiclesWritten}`);

    // CR-2026-106 — "Import Complete" is a checked statement: reconcile the SAME plan
    // against the database we just wrote. Every planned customer/vehicle must now be
    // present by exact key; anything else is printed, not assumed.
    const report = await reconcileAgainstDb(prisma, plan, source);
    writeReconciliation(report, 'POST-COMMIT');
    await recordRun(prisma, 'COMMIT', startedAt, report, batchId);
    const complete = report.customers.exactKey === report.customers.planned && report.vehicles.exactKey === report.vehicles.planned;
    console.warn(complete
      ? `  Import complete: ${report.customers.exactKey}/${report.customers.planned} customers and ${report.vehicles.exactKey}/${report.vehicles.planned} vehicles present by exact key.`
      : `  Import INCOMPLETE: ${report.customers.exactKey}/${report.customers.planned} customers, ${report.vehicles.exactKey}/${report.vehicles.planned} vehicles present by exact key — see ${OUT_DIR}/import-exceptions.csv`);
    console.warn(`  rollback with: tsx apps/api/scripts/import-customers.ts --rollback ${batchId}\n`);
    if (!complete) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

async function upsertRef(prisma: PrismaClient, entityType: 'Customer' | 'Vehicle', entityId: string, externalId: string, batchId: string, meta: Record<string, unknown>) {
  // Backfill-safe: on UPDATE we deliberately do NOT touch metadata, so the ORIGINAL
  // import batch lineage (importBatchId) is preserved. Batch tag is set on create only.
  await prisma.externalSystemRef.upsert({
    where: { system_entityType_entityId: { system: SYSTEM, entityType, entityId } },
    update: { externalId, syncStatus: 'SYNCED' },
    create: { system: SYSTEM, entityType, entityId, externalId, syncStatus: 'SYNCED', metadata: { importBatchId: batchId, ...meta } as never },
  });
}

// ---------------------------------------------------------------------------
// ROLLBACK a committed batch
// ---------------------------------------------------------------------------
async function rollback(batchId: string) {
  const prisma = new PrismaClient();
  try {
    const refs = await prisma.externalSystemRef.findMany({ where: { system: SYSTEM, entityType: { in: ['Vehicle', 'Customer'] } } });
    const batchRefs = refs.filter((r) => (r.metadata as { importBatchId?: string } | null)?.importBatchId === batchId);
    const vehicleIds = [...new Set(batchRefs.filter((r) => r.entityType === 'Vehicle').map((r) => r.entityId))];

    await prisma.externalSystemRef.deleteMany({ where: { id: { in: batchRefs.map((r) => r.id) } } });
    // vehicleIds are derived solely from this batch's refs → already batch-scoped.
    await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    // Delete batch customers that now have no vehicles left.
    const custs = await prisma.customer.findMany({ where: { notes: { contains: `import:${batchId}` } }, include: { vehicles: true } });
    const orphan = custs.filter((c) => c.vehicles.length === 0).map((c) => c.id);
    await prisma.customer.deleteMany({ where: { id: { in: orphan } } });
    await prisma.importRun.create({
      data: { system: SYSTEM, mode: 'ROLLBACK', sourceFile: basename(FILE), batchId, startedAt: new Date(), finishedAt: new Date(), totals: { vehiclesRemoved: vehicleIds.length, refsRemoved: batchRefs.length, customersRemoved: orphan.length } as never, reconciles: true, actor: ACTOR, databaseLabel: databaseLabel() },
    });

    console.warn(`\nROLLBACK batch ${batchId}: removed ${vehicleIds.length} vehicles, ${batchRefs.length} refs, ${orphan.length} customers.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

// --- entry ---
(async () => {
  if (MODE === 'dry-run') dryRun();
  else if (MODE === 'reconcile') await reconcile();
  else if (MODE === 'commit') await commit();
  else if (MODE === 'rollback') {
    if (!ROLLBACK_ID) { console.error('--rollback requires a batchId'); process.exit(1); }
    await rollback(ROLLBACK_ID);
  }
})().catch((e) => { console.error(e); process.exit(1); });
