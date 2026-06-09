/**
 * Customer + Vehicle importer (CR-2026-003).
 *
 * Modes:
 *   (default)            DRY-RUN — reads CSV, plans, writes report to demo-output/. NO DB writes.
 *   --commit             Idempotent write into Customer/Vehicle (+ ExternalSystemRef). Batch-tagged.
 *   --rollback <batchId> Delete a previously committed batch.
 *   --file <path>        CSV path (default: ./customers.csv)
 *
 * Guardrails: customers + vehicles ONLY (no jobs/visits). Imported contacts get
 * notification opt-in = FALSE (no proven consent). Real PII stays in git-ignored
 * customers.csv + demo-output/. Run with VIN_DECODE_PROVIDER=STUB (no outbound calls).
 *
 *   tsx apps/api/scripts/import-customers.ts            # dry-run
 *   tsx apps/api/scripts/import-customers.ts --commit   # write (after report review)
 *   tsx apps/api/scripts/import-customers.ts --rollback <batchId>
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  rawRowFromCsv,
  planImport,
  type ImportPlan,
} from '../src/modules/data-import/customer-vehicle.mapper';

const SYSTEM = 'SHAREPOINT_CONTACT_DB' as const;
const OUT_DIR = 'demo-output';

// --- args ---
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const MODE = has('--rollback') ? 'rollback' : has('--commit') ? 'commit' : 'dry-run';
const FILE = val('--file') ?? 'customers.csv';
const ROLLBACK_ID = val('--rollback');

// --- minimal CSV parser (quoted fields, embedded commas/newlines) ---
function parseCsv(s: string): Record<string, string>[] {
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
  return rows.slice(1).filter((r) => r.length >= header.length - 3 && r.some((x) => x !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function loadPlan(): ImportPlan {
  const records = parseCsv(readFileSync(FILE, 'utf8'));
  const rows = records.filter((r) => (r['Id'] ?? '').trim()).map(rawRowFromCsv);
  return planImport(rows);
}

// ---------------------------------------------------------------------------
// DRY-RUN
// ---------------------------------------------------------------------------
function dryRun() {
  const plan = loadPlan();
  const c = plan.counts;
  mkdirSync(OUT_DIR, { recursive: true });

  const summary = [
    `# Customer + Vehicle Import — DRY RUN`,
    ``,
    `> No database writes. Source: \`${FILE}\`. Generated for review (CR-2026-003).`,
    ``,
    `## Counts`,
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Rows read | ${c.rowsRead} |`,
    `| **Customers to create** | ${c.customersToCreate} |`,
    `| Customer merges (rows joining an existing customer) | ${c.customerMerges} |`,
    `| **Vehicles to create** | ${c.vehiclesToCreate} |`,
    `| Duplicate plates (own vehicle, disambiguated code) | ${c.duplicatePlates} |`,
    `| ⚠ Suspicious merges (placeholder phone) | ${c.suspiciousMerges} |`,
    `| Flag: missing name | ${c.missingName} |`,
    `| Flag: missing/junk plate | ${c.missingOrJunkPlate} |`,
    `| Flag: missing VIN | ${c.missingVin} |`,
    `| Flag: duplicate VIN (nulled) | ${c.duplicateVin} |`,
    `| Total flagged rows | ${plan.flagged.length} |`,
    ``,
    `## Sample flagged rows (first 15, by contact Id + issue only)`,
    ...plan.flagged.slice(0, 15).map((f) => `- contact ${f.contactId}: ${f.issues.join(', ')}`),
    ``,
    `Full detail (with values) in \`import-flagged-rows.csv\` (git-ignored).`,
    ``,
  ].join('\n');

  const csv = ['contactId,issues,detail',
    ...plan.flagged.map((f) => `${f.contactId},"${f.issues.join(';')}","${(f.detail || '').replace(/"/g, '""')}"`),
  ].join('\r\n');

  writeFileSync(join(OUT_DIR, 'import-dryrun-summary.md'), summary, 'utf8');
  writeFileSync(join(OUT_DIR, 'import-flagged-rows.csv'), csv, 'utf8');

  console.warn(`\nDRY-RUN complete — NO DB writes.`);
  console.warn(`  rows=${c.rowsRead}  customers=${c.customersToCreate}  vehicles=${c.vehiclesToCreate}  ` +
    `dupPlates=${c.duplicatePlates}  suspiciousMerges=${c.suspiciousMerges}  flagged=${plan.flagged.length}`);
  console.warn(`  report -> ${OUT_DIR}/import-dryrun-summary.md  (+ import-flagged-rows.csv)\n`);
}

// ---------------------------------------------------------------------------
// COMMIT (idempotent, batch-tagged) — NOT run until dry-run is approved
// ---------------------------------------------------------------------------
async function commit() {
  const prisma = new PrismaClient();
  const plan = loadPlan();
  const batchId = randomUUID();
  let customersWritten = 0, vehiclesWritten = 0;

  try {
    const customerIdByNumber = new Map<string, string>();
    for (const cu of plan.customers) {
      const note = `import:${batchId}; raw="${cu.rawName}"`;
      const rec = await prisma.customer.upsert({
        where: { customerNumber: cu.customerNumber },
        update: { firstName: cu.firstName, lastName: cu.lastName, phone: cu.phone, email: cu.email ?? undefined },
        create: {
          customerNumber: cu.customerNumber, firstName: cu.firstName, lastName: cu.lastName,
          phone: cu.phone, email: cu.email ?? undefined,
          notificationOptInSms: false, notificationOptInEmail: false, // no proven consent
          notes: note,
        },
      });
      customerIdByNumber.set(cu.customerNumber, rec.id);
      customersWritten++;
    }

    for (const v of plan.vehicles) {
      const customerId = customerIdByNumber.get(v.customerNumber)!;
      let vehicleId: string;
      try {
        const rec = await prisma.vehicle.upsert({
          where: { vehicleCode: v.vehicleCode },
          update: { customerId, plateNumber: v.plateNumber ?? '', make: v.make, model: v.model, modelYear: v.modelYear },
          create: {
            customerId, vehicleCode: v.vehicleCode, plateNumber: v.plateNumber ?? '',
            vin: v.vin ?? undefined, make: v.make, model: v.model, modelYear: v.modelYear,
            // NOTE: Vehicle has no `notes` field — batch tag lives on ExternalSystemRef.metadata.
          },
        });
        vehicleId = rec.id;
      } catch {
        // unique collision (e.g. VIN already in DB) → retry without vin
        const rec = await prisma.vehicle.upsert({
          where: { vehicleCode: v.vehicleCode },
          update: { customerId, plateNumber: v.plateNumber ?? '', make: v.make, model: v.model, modelYear: v.modelYear },
          create: { customerId, vehicleCode: v.vehicleCode, plateNumber: v.plateNumber ?? '', make: v.make, model: v.model, modelYear: v.modelYear },
        });
        vehicleId = rec.id;
      }
      await upsertRef(prisma, vehicleId, v.contactId, batchId);
      vehiclesWritten++;
    }

    console.warn(`\nCOMMIT complete (batch ${batchId}):`);
    console.warn(`  customers=${customersWritten}  vehicles=${vehiclesWritten}`);
    console.warn(`  rollback with: tsx apps/api/scripts/import-customers.ts --rollback ${batchId}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

async function upsertRef(prisma: PrismaClient, vehicleId: string, contactId: string, batchId: string) {
  await prisma.externalSystemRef.upsert({
    where: { system_entityType_entityId: { system: SYSTEM as any, entityType: 'Vehicle', entityId: vehicleId } },
    update: { externalId: contactId, syncStatus: 'SYNCED', metadata: { importBatchId: batchId, contactId } },
    create: { system: SYSTEM as any, entityType: 'Vehicle', entityId: vehicleId, externalId: contactId, syncStatus: 'SYNCED', metadata: { importBatchId: batchId, contactId } },
  });
}

// ---------------------------------------------------------------------------
// ROLLBACK a committed batch
// ---------------------------------------------------------------------------
async function rollback(batchId: string) {
  const prisma = new PrismaClient();
  try {
    const refs = await prisma.externalSystemRef.findMany({ where: { system: SYSTEM as any, entityType: 'Vehicle' } });
    const batchRefs = refs.filter((r) => (r.metadata as any)?.importBatchId === batchId);
    const vehicleIds = [...new Set(batchRefs.map((r) => r.entityId))];

    await prisma.externalSystemRef.deleteMany({ where: { id: { in: batchRefs.map((r) => r.id) } } });
    // vehicleIds are derived solely from this batch's refs → already batch-scoped.
    await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    // Delete batch customers that now have no vehicles left.
    const custs = await prisma.customer.findMany({ where: { notes: { contains: `import:${batchId}` } }, include: { vehicles: true } });
    const orphan = custs.filter((c) => c.vehicles.length === 0).map((c) => c.id);
    await prisma.customer.deleteMany({ where: { id: { in: orphan } } });

    console.warn(`\nROLLBACK batch ${batchId}: removed ${vehicleIds.length} vehicles, ${batchRefs.length} refs, ${orphan.length} customers.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

// --- entry ---
(async () => {
  if (MODE === 'dry-run') dryRun();
  else if (MODE === 'commit') await commit();
  else if (MODE === 'rollback') {
    if (!ROLLBACK_ID) { console.error('--rollback requires a batchId'); process.exit(1); }
    await rollback(ROLLBACK_ID);
  }
})().catch((e) => { console.error(e); process.exit(1); });
