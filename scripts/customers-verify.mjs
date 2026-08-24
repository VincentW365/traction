/**
 * CR-2026-094 — post-import verification. READ-ONLY.
 *
 *   pnpm customers:verify
 *
 * Answers "did the customer import actually land, and is it healthy?" after a
 * deployment. Production may legitimately hold MORE records than the imported
 * dataset — real use adds customers — so this never fails on extra rows. What it
 * reports is the shape: totals, orphans, duplicate candidates, and the import
 * batches recorded on ExternalSystemRef.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

console.log('\nBSOP customer database verification (read-only)\n');

const problems = [];

// --- totals -----------------------------------------------------------------
const customers = await prisma.customer.count();
const vehicles = await prisma.vehicle.count();
const visits = await prisma.serviceVisit.count();
console.log('Totals:');
console.log(`  customers      ${customers}`);
console.log(`  vehicles       ${vehicles}`);
console.log(`  service visits ${visits}`);

// --- relationships ----------------------------------------------------------
const customersWithoutVehicles = await prisma.customer.count({ where: { vehicles: { none: {} } } });
const [{ orphanVehicles }] = await prisma.$queryRawUnsafe(
  `SELECT count(*)::int AS "orphanVehicles" FROM vehicles v
   LEFT JOIN customers c ON c.id = v.customer_id WHERE c.id IS NULL`,
);
console.log('\nRelationships:');
console.log(`  customers without vehicles ${customersWithoutVehicles}  (legitimate — parts-only customers exist)`);
console.log(`  vehicles without a customer ${orphanVehicles}`);
if (orphanVehicles > 0) problems.push(`${orphanVehicles} vehicle(s) reference no customer`);

// --- duplicate candidates ---------------------------------------------------
// Candidates, not verdicts: the import dedupes on stable identifiers
// (customerNumber / vehicleCode), so anything surfacing here arrived another way
// and deserves a person's eye, not an automatic merge.
const dupPhones = await prisma.$queryRawUnsafe(
  `SELECT phone, count(*)::int AS n FROM customers
   WHERE phone IS NOT NULL AND phone <> ''
   GROUP BY phone HAVING count(*) > 1 ORDER BY n DESC LIMIT 5`,
);
const [{ dupPlates }] = await prisma.$queryRawUnsafe(
  `SELECT count(*)::int AS "dupPlates" FROM (
     SELECT plate_number FROM vehicles WHERE plate_number <> ''
     GROUP BY plate_number HAVING count(*) > 1
   ) d`,
);
console.log('\nDuplicate candidates (for review, not auto-merged):');
console.log(`  phone numbers shared by 2+ customers: ${dupPhones.length}${dupPhones.length ? ' (top: ' + dupPhones.map((d) => `${d.n}x`).join(', ') + ')' : ''}`);
console.log(`  plate numbers shared by 2+ vehicles:  ${dupPlates}`);

// --- identifiers ------------------------------------------------------------
const [{ blankNumbers }] = await prisma.$queryRawUnsafe(
  `SELECT count(*)::int AS "blankNumbers" FROM customers WHERE customer_number IS NULL OR customer_number = ''`,
);
if (blankNumbers > 0) problems.push(`${blankNumbers} customer(s) have no customer number`);
console.log('\nIdentifiers:');
console.log(`  customers missing a customer number: ${blankNumbers}`);

// --- import batches ---------------------------------------------------------
// The importer tags every vehicle with its batch id on ExternalSystemRef.metadata,
// which is what makes "was the import actually run here?" provable.
const refs = await prisma.externalSystemRef.count();
const batches = await prisma.$queryRawUnsafe(
  `SELECT metadata->>'importBatchId' AS batch, count(*)::int AS n, min(created_at) AS started
   FROM external_system_refs
   WHERE metadata->>'importBatchId' IS NOT NULL
   GROUP BY 1 ORDER BY started DESC LIMIT 10`,
);
console.log('\nImport batches (from ExternalSystemRef):');
console.log(`  external refs total: ${refs}`);
if (batches.length === 0) {
  console.log('  no import batches recorded — the controlled import has not run against this database');
} else {
  for (const b of batches) {
    console.log(`  batch ${String(b.batch).slice(0, 8)}…  ${b.n} record(s)  started ${new Date(b.started).toISOString()}`);
  }
}

// --- verdict ----------------------------------------------------------------
if (customers === 0) {
  console.log('\nRESULT: EMPTY — no customers in this database. If a populated deployment was');
  console.log('expected, run the approved import (docs/DEPLOYMENT_HANDOFF.md).');
  process.exit(1);
}
if (problems.length) {
  console.log('\nRESULT: ISSUES —');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nRESULT: OK — customer database present and structurally sound.');
await prisma.$disconnect();
