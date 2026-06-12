/**
 * Vehicle code format backfill (CR-2026-027).
 *
 *   (default)                 DRY-RUN — transform plan + collision report. NO writes.
 *   --commit --backup <path>  Rewrite plate-derived vehicle codes from the old
 *                             hyphenated form `SC-<plate>` to SharePoint's exact
 *                             form `SC<plate>` (strip the hyphen right after "SC").
 *                             Requires a pg_dump path (acknowledges a backup was taken).
 *
 * SCOPE / GUARDRAILS:
 *  - Touches ONLY vehicles.vehicle_code (a @unique business reference). Never
 *    customers, customer_number, plates, VINs, jobs, queue, ETA, or scheduling.
 *  - Candidates: vehicle_code LIKE 'SC-%' AND NOT LIKE 'SC-CONTACT-%'.
 *    -> converts `SC-1211KC` -> `SC1211KC` and the duplicate-plate disambiguator
 *       `SC-DUP123-2` -> `SCDUP123-2` (trailing `-<id>` preserved).
 *    -> LEAVES `SC-CONTACT-<id>` junk fallbacks unchanged (matches the import mapper).
 *  - Collision-safe: aborts --commit if any new code already exists on a different
 *    row, or if two old codes map to the same new code (vehicle_code is @unique).
 *  - Idempotent: after commit, plate codes no longer start `SC-`, so re-runs are no-ops.
 *  - No PII printed (vehicle codes only; codes are not PII).
 *
 * MUST run BEFORE the generator/mapper format flip (CR-2026-027 P2) so the next
 * SharePoint re-import upserts by the new `vehicleCode` and does not duplicate rows.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const bIdx = argv.indexOf('--backup');
const BACKUP = bIdx >= 0 ? argv[bIdx + 1] : undefined;

/** New code: strip the single hyphen right after "SC" (index 2). */
function toNewCode(oldCode: string): string {
  return 'SC' + oldCode.slice(3); // "SC-1211KC" -> "SC" + "1211KC"; "SC-DUP-2" -> "SCDUP-2"
}

async function main() {
  const prisma = new PrismaClient();
  try {
    if (COMMIT && (!BACKUP || BACKUP.trim() === '')) {
      throw new Error(
        'Refusing --commit without --backup <path>. Take a pg_dump of bsop_dev first, then pass its path:\n' +
          '  pg_dump "$DATABASE_URL" > backup_pre_vehicle_code_backfill.sql\n' +
          '  tsx apps/api/scripts/backfill-vehicle-codes.ts --commit --backup backup_pre_vehicle_code_backfill.sql',
      );
    }

    // Candidates: old-format plate codes only (exclude the SC-CONTACT- junk fallback).
    const candidates = await prisma.vehicle.findMany({
      where: {
        vehicleCode: { startsWith: 'SC-' },
        NOT: { vehicleCode: { startsWith: 'SC-CONTACT-' } },
      },
      select: { id: true, vehicleCode: true },
    });

    // Every existing code (for the "target already exists" collision check).
    const allCodes = await prisma.vehicle.findMany({ select: { id: true, vehicleCode: true } });
    const idByCode = new Map(allCodes.map((v) => [v.vehicleCode, v.id]));

    // Compute transforms + collisions.
    const plan = candidates.map((c) => ({ id: c.id, oldCode: c.vehicleCode, newCode: toNewCode(c.vehicleCode) }));
    const targetCollisions = plan.filter((p) => {
      const owner = idByCode.get(p.newCode);
      return owner !== undefined && owner !== p.id; // a DIFFERENT row already holds newCode
    });
    const byNew = new Map<string, string[]>();
    for (const p of plan) {
      const arr = byNew.get(p.newCode) ?? [];
      arr.push(p.id);
      byNew.set(p.newCode, arr);
    }
    const dupTargets = [...byNew.entries()].filter(([, ids]) => new Set(ids).size > 1);
    const collisions = targetCollisions.length > 0 || dupTargets.length > 0;

    // Non-candidate SC* codes (for eyeballing oddities — SC-CONTACT-*, already-new, malformed).
    const scish = await prisma.vehicle.count({ where: { vehicleCode: { startsWith: 'SC' } } });
    const alreadyNew = await prisma.vehicle.count({
      where: { vehicleCode: { startsWith: 'SC' }, NOT: { vehicleCode: { startsWith: 'SC-' } } },
    });
    const contactFallbacks = await prisma.vehicle.count({ where: { vehicleCode: { startsWith: 'SC-CONTACT-' } } });

    console.warn('--- Vehicle code backfill (CR-2026-027) ---');
    console.warn(`mode:                 ${COMMIT ? 'COMMIT' : 'DRY-RUN (no writes)'}`);
    console.warn(`candidates (SC-…, not SC-CONTACT-): ${plan.length}`);
    console.warn(`SC* codes total:      ${scish}`);
    console.warn(`  already new (SC<plate>, no hyphen): ${alreadyNew}`);
    console.warn(`  SC-CONTACT- fallbacks (left as-is): ${contactFallbacks}`);
    console.warn('sample old -> new:');
    for (const p of plan.slice(0, 12)) console.warn(`  ${p.oldCode.padEnd(20)} -> ${p.newCode}`);
    console.warn('collision report:');
    console.warn(`  target already exists: ${targetCollisions.length}`);
    for (const c of targetCollisions.slice(0, 20)) console.warn(`    ${c.oldCode} -> ${c.newCode} (conflicts with existing row ${idByCode.get(c.newCode)})`);
    console.warn(`  two old codes -> same new: ${dupTargets.length}`);
    for (const [nc, ids] of dupTargets.slice(0, 20)) console.warn(`    ${nc} <- ${ids.length} rows (${ids.join(', ')})`);

    if (!COMMIT) {
      console.warn(`\nDRY-RUN: ${plan.length} rows WOULD change. Re-run with --commit --backup <path> to apply.`);
      console.warn(collisions ? 'COLLISIONS PRESENT — --commit would refuse until resolved.' : 'No collisions — safe to commit.');
      return;
    }

    if (collisions) {
      throw new Error(
        `Refusing --commit: ${targetCollisions.length} target collisions + ${dupTargets.length} duplicate-target groups. Resolve manually (see report above).`,
      );
    }

    // Single transactional UPDATE; the collision pre-check guarantees no @unique violation.
    const rowsUpdated = await prisma.$transaction(async (tx) => {
      return tx.$executeRaw`
        UPDATE vehicles
        SET vehicle_code = 'SC' || substring(vehicle_code from 4), updated_at = now()
        WHERE vehicle_code LIKE 'SC-%' AND vehicle_code NOT LIKE 'SC-CONTACT-%'
      `;
    });

    console.warn(`\nCOMMITTED. rows updated: ${rowsUpdated} (expected ${plan.length}).`);
    console.warn(`backup acknowledged:  ${BACKUP}`);
    if (rowsUpdated !== plan.length) {
      console.warn('WARNING: rowsUpdated != candidate count — investigate (concurrent writes?).');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e?.message ?? e}`);
  process.exit(1);
});
