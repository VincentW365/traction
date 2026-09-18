/**
 * CR-2026-108 Stage 5C — the eight-bay verified baseline.
 *
 *   pnpm resources:baseline          # show what it would do
 *   pnpm resources:baseline --commit # apply it
 *
 * Management confirmed EIGHT physical heavy-lift bays. This configures them as
 * eight distinct WorkResource records classified PRIMARY_SERVICE_POSITION with the
 * GENERAL capability — through `ResourceAdminService`, so every change is validated
 * and audited exactly as it would be from the Resources & Bays screen.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *   - It does not write `capacity = 8` anywhere. There is no such number. The
 *     derived count equals eight because eight verified resources exist, and it
 *     will equal nine the moment a manager adds a ninth.
 *   - It does not give the eight ALIGNMENT, LUBE, TIRE or INSPECTION. Being a
 *     heavy lift says a vehicle fits; it does not say the alignment rack is in
 *     that bay. Specialist capabilities stay explicitly configurable (§4, §5).
 *   - It does not classify anything it cannot justify. The overflow slots, the
 *     light-task slots, the wash bay and the two ambiguous jack rows stay
 *     UNVERIFIED and contribute zero until somebody says otherwise (§24).
 *
 * Re-running it is safe: everything is matched by code and skipped when already
 * correct, so it is a reconciliation step rather than a one-shot migration.
 */
import { PrismaClient } from '@prisma/client';
import { ResourceAdminService } from '../apps/api/src/modules/resources/resource-admin.service';
import { AuditService } from '../apps/api/src/modules/audit/audit.service';
import type { PrismaService } from '../apps/api/src/infrastructure/prisma/prisma.service';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const out = (m: string) => console.log(`  ${m}`);

/**
 * The eight. Three are existing lift bays, two are the rows the shop had written
 * down as "(TBD)" and management has now confirmed are commissioned, and three
 * are new records for bays the pre-expansion inventory never had.
 *
 * BAY-03 is included and FLAGGED: it is recorded as a 'sedan' lift at STANDARD
 * weight rather than 'heavy', but it accepts both vehicle classes and is a full
 * lift position. If it is not one of the eight management means, change its role
 * on the Resources & Bays screen and add the eighth — no code changes.
 */
const HEAVY_LIFT_BAYS = [
  { code: 'BAY-01', name: 'Heavy Lift 1', create: false, note: 'existing heavy lift' },
  { code: 'BAY-02', name: 'Heavy Lift 2', create: false, note: 'existing heavy lift' },
  { code: 'BAY-03', name: 'Sedan Lift', create: false, note: "existing lift — recorded as 'sedan'/STANDARD, CONFIRM it is one of the eight" },
  { code: 'BAY-06', name: 'Heavy Lift 6', create: false, note: 'was "Bay 6 (TBD)" — management confirms it is commissioned' },
  { code: 'BAY-07', name: 'Heavy Lift 7', create: false, note: 'was "Bay 7 (TBD)" — management confirms it is commissioned' },
  { code: 'BAY-08', name: 'Heavy Lift 8', create: true, note: 'created — expansion bay not in the pre-expansion inventory' },
  { code: 'BAY-09', name: 'Heavy Lift 9', create: true, note: 'created — expansion bay not in the pre-expansion inventory' },
  { code: 'BAY-10', name: 'Heavy Lift 10', create: true, note: 'created — expansion bay not in the pre-expansion inventory' },
];

/**
 * Unambiguous equipment: a jack or a stand is a tool used AT a position, not a
 * position. Counting them is how one vehicle on one jack with two stands becomes
 * four bookings. SUPPORT_EQUIPMENT contributes zero, same as UNVERIFIED — but it
 * is a DECISION that it contributes zero, which is the difference.
 *
 * BAY-04 (Mobile Lift) and BAY-05 (Power Jack) are NOT in this list even though
 * they read like jacks: they sit in the BAY code series, which suggests the shop
 * may treat them as positions. Ambiguous stays UNVERIFIED.
 */
const SUPPORT_EQUIPMENT = ['MJACK-01', 'MJACK-02', 'STAND-01', 'STAND-02'];

async function main() {
  const admin = new ResourceAdminService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService));
  const site = await prisma.site.findFirstOrThrow({ select: { id: true, name: true } });
  const actor = await prisma.userAccount.findFirstOrThrow({
    where: { roleCode: 'ADMIN', status: 'ACTIVE' },
    select: { id: true, fullName: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\nCR-2026-108 Stage 5C — resource baseline for ${site.name}`);
  console.log(COMMIT ? '  MODE: COMMIT\n' : '  MODE: DRY RUN (pass --commit to apply)\n');

  console.log('  Eight verified heavy-lift bays');
  console.log('  ' + '-'.repeat(74));
  for (const bay of HEAVY_LIFT_BAYS) {
    const existing = await prisma.workResource.findFirst({
      where: { siteId: site.id, code: bay.code },
      select: { id: true, name: true, capacityRole: true, retiredAt: true, serviceCapabilities: { select: { capability: true } } },
    });

    if (!existing) {
      if (!bay.create) {
        out(`${bay.code.padEnd(10)} MISSING and not expected to be created — check the inventory by hand.`);
        continue;
      }
      if (!COMMIT) {
        out(`${bay.code.padEnd(10)} would CREATE "${bay.name}" as PRIMARY_SERVICE_POSITION + GENERAL  (${bay.note})`);
        continue;
      }
      const created = await admin.create(
        site.id,
        {
          code: bay.code,
          name: bay.name,
          resourceCategory: 'BAY',
          liftType: 'heavy',
          maxVehicleWeight: 'HEAVY',
          requiresMechanic: true,
          supportsSedan: true,
          supportsSuv: true,
          schedulingEnabled: true,
          capacity: 1,
          capacityRole: 'PRIMARY_SERVICE_POSITION',
          notes: 'PROVISIONAL — mapped to the confirmed eight-bay count, not yet checked in the building (CR-2026-108 §1).',
        },
        actor.id,
      );
      await admin.setCapabilities(created.id, ['GENERAL'], actor.id);
      out(`${bay.code.padEnd(10)} CREATED "${bay.name}" — PRIMARY_SERVICE_POSITION + GENERAL  (${bay.note})`);
      continue;
    }

    if (existing.retiredAt) {
      out(`${bay.code.padEnd(10)} is RETIRED — reactivate it deliberately rather than from a script.`);
      continue;
    }

    const changes: string[] = [];
    if (existing.name !== bay.name) changes.push(`name "${existing.name}" -> "${bay.name}"`);
    if (String(existing.capacityRole) !== 'PRIMARY_SERVICE_POSITION') {
      changes.push(`role ${existing.capacityRole} -> PRIMARY_SERVICE_POSITION`);
    }
    const caps = existing.serviceCapabilities.map((c) => c.capability);
    // Union, never replace: a specialist capability somebody has already assigned
    // must survive this script. Only GENERAL is being asserted here.
    const wanted = [...new Set([...caps, 'GENERAL'])].sort();
    if (JSON.stringify(caps.sort()) !== JSON.stringify(wanted)) changes.push(`capabilities [${caps.join(',') || 'none'}] -> [${wanted.join(',')}]`);

    if (changes.length === 0) {
      out(`${bay.code.padEnd(10)} already correct`);
      continue;
    }
    if (!COMMIT) {
      out(`${bay.code.padEnd(10)} would UPDATE: ${changes.join('; ')}  (${bay.note})`);
      continue;
    }
    await admin.update(existing.id, { name: bay.name, capacityRole: 'PRIMARY_SERVICE_POSITION' }, actor.id);
    await admin.setCapabilities(existing.id, wanted, actor.id);
    out(`${bay.code.padEnd(10)} UPDATED: ${changes.join('; ')}`);
  }

  console.log('\n  Equipment (contributes zero — a decision, not an absence)');
  console.log('  ' + '-'.repeat(74));
  for (const code of SUPPORT_EQUIPMENT) {
    const r = await prisma.workResource.findFirst({ where: { siteId: site.id, code }, select: { id: true, name: true, capacityRole: true } });
    if (!r) { out(`${code.padEnd(10)} not found`); continue; }
    if (String(r.capacityRole) === 'SUPPORT_EQUIPMENT') { out(`${code.padEnd(10)} already SUPPORT_EQUIPMENT`); continue; }
    if (!COMMIT) { out(`${code.padEnd(10)} would set ${r.capacityRole} -> SUPPORT_EQUIPMENT  ("${r.name}")`); continue; }
    await admin.update(r.id, { capacityRole: 'SUPPORT_EQUIPMENT' }, actor.id);
    out(`${code.padEnd(10)} SUPPORT_EQUIPMENT  ("${r.name}")`);
  }

  // --- what is deliberately left alone -------------------------------------
  const untouched = await prisma.workResource.findMany({
    where: {
      siteId: site.id,
      retiredAt: null,
      code: { notIn: [...HEAVY_LIFT_BAYS.map((b) => b.code), ...SUPPORT_EQUIPMENT] },
    },
    select: { code: true, name: true, capacityRole: true, resourceCategory: true },
    orderBy: { code: 'asc' },
  });
  console.log('\n  Left UNVERIFIED on purpose — management configures these when confirmed');
  console.log('  ' + '-'.repeat(74));
  for (const r of untouched) {
    out(`${r.code.padEnd(10)} ${String(r.capacityRole).padEnd(18)} ${r.name}`);
  }

  // --- the derived figure, read back ----------------------------------------
  const verified = await prisma.workResource.findMany({
    where: {
      siteId: site.id,
      retiredAt: null,
      isActive: true,
      schedulingEnabled: true,
      capacityRole: { in: ['PRIMARY_SERVICE_POSITION', 'OVERFLOW_SERVICE_POSITION'] },
    },
    select: { code: true, capacity: true, operationalStatus: { select: { status: true } } },
  });
  const usable = verified.filter((r) => (r.operationalStatus?.status ?? 'AVAILABLE') === 'AVAILABLE');
  console.log('\n  ' + '='.repeat(74));
  console.log(`  Derived verified active positions: ${usable.reduce((n, r) => n + r.capacity, 0)}`);
  console.log('  Derived because that many verified resources exist — not because any');
  console.log('  number was written down. Add a bay and it rises on the next read.');
  console.log('  ' + '='.repeat(74) + '\n');

  if (!COMMIT) console.log('  Nothing was written. Re-run with --commit to apply.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
