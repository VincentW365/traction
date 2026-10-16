/**
 * CR-2026-119 — the resource baseline, corrected to the building.
 *
 *   pnpm resources:baseline            # dry run: prints what it WOULD do
 *   pnpm resources:baseline --commit   # applies it, through the audited admin service
 *
 * WHAT CHANGED, AND WHY
 *
 * The previous version (CR-2026-108 Stage 5C) classified eight records as heavy
 * lifts on the strength of "management confirmed eight bays". The photographic
 * audit of 2026-10-15/16 found what the building actually holds:
 *
 *   four two-post lifts (positions 1, 2, 4, 8)
 *   two drive-on runway lifts (positions 3, 6)
 *   two ground-level positions with no fixed lift (positions 5, 7)
 *   one dedicated vehicle wash area
 *   one bushing/bearings press
 *
 * That is eight POSITIONS, not eight heavy lifts. This script now describes that
 * inventory and nothing more. It is deliberately conservative in three ways:
 *
 *   1. It never maps a handwritten position number onto a BAY code. Which
 *      existing record IS which lift is unconfirmed (directive §2), so on an
 *      EXISTING database it does not touch the lift records at all. It reports
 *      them for a person to link, by typing the position onto the record.
 *   2. On a FRESH database (no lift records exist) it creates the six lifting
 *      stations keyed by their physical position, with the lift type the
 *      photographs show and NO weight rating assumed — ratings are unverified
 *      (§2: "do not assume heavy-duty solely because it can accommodate an SUV").
 *      The two ground-level positions are created UNVERIFIED: they exist, and
 *      they contribute nothing until their use is confirmed (§3).
 *   3. It never increases booking capacity. `booking_capacity_mode` stays FIXED
 *      (§9); this script only describes resources, and even resource-aware mode
 *      is gated behind readiness checks and a manager's deliberate switch.
 *
 * What it DOES do on every database, because management has confirmed it:
 *
 *   - PWASH-01 becomes the dedicated Vehicle Wash Bay: PRIMARY (one vehicle at
 *     a time), capability CLEANING only, so it can never take mechanical work and
 *     mechanical positions can never take a wash (§5). Reused rather than
 *     creating "WASH-01": the directive asks that proposed codes be checked
 *     against existing records first, and PWASH-01 is that record.
 *   - PRESS-01 is created: SUPPORT_EQUIPMENT, zero vehicle capacity, not
 *     schedulable, shown on the dispatch board so its status can be set by hand
 *     — the "simple availability indicator" §6 asks for, and nothing heavier.
 *   - MSHOP-EXT is confirmed EXTERNAL and left distinct from the press (§6).
 *   - MJACK-01/02 and STAND-01/02 remain SUPPORT_EQUIPMENT.
 *
 * Idempotent and matched by code: every step is skipped when already correct,
 * so re-running is a reconciliation, not a migration. Nothing is deleted.
 */
import { PrismaClient } from '@prisma/client';
import { ResourceAdminService } from '../apps/api/src/modules/resources/resource-admin.service';
import { AuditService } from '../apps/api/src/modules/audit/audit.service';
import type { PrismaService } from '../apps/api/src/infrastructure/prisma/prisma.service';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const out = (m: string) => console.log(`  ${m}`);

/** The lifting stations the photographs establish, by the position the floor uses. */
const LIFTING_STATIONS = [
  { position: 'Position 1', code: 'LIFT-P1', name: 'Two-post lift — Position 1', liftType: 'two_post' },
  { position: 'Position 2', code: 'LIFT-P2', name: 'Two-post lift — Position 2', liftType: 'two_post' },
  { position: 'Position 3', code: 'LIFT-P3', name: 'Runway lift — Position 3', liftType: 'runway' },
  { position: 'Position 4', code: 'LIFT-P4', name: 'Two-post lift — Position 4', liftType: 'two_post' },
  { position: 'Position 6', code: 'LIFT-P6', name: 'Runway lift — Position 6', liftType: 'runway' },
  { position: 'Position 8', code: 'LIFT-P8', name: 'Two-post lift — Position 8', liftType: 'two_post' },
] as const;

/** Covered ground-level positions: real places, unconfirmed use. Created UNVERIFIED on a fresh database. */
const GROUND_POSITIONS = [
  { position: 'Position 5', code: 'GROUND-P5', name: 'Ground-level position 5' },
  { position: 'Position 7', code: 'GROUND-P7', name: 'Ground-level position 7' },
] as const;

/** Lift records that may already exist from the pre-expansion inventory. Reported, never altered. */
const LEGACY_LIFT_CODES = ['BAY-01', 'BAY-02', 'BAY-03', 'BAY-06', 'BAY-07', 'BAY-08', 'BAY-09', 'BAY-10'];

const SUPPORT_EQUIPMENT = ['MJACK-01', 'MJACK-02', 'STAND-01', 'STAND-02'];

type Existing = {
  id: string;
  code: string;
  name: string;
  capacityRole: string;
  resourceCategory: string;
  retiredAt: Date | null;
  schedulingEnabled: boolean;
  physicalPosition: string | null;
  serviceCapabilities: { capability: string }[];
};

async function main() {
  const admin = new ResourceAdminService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService));
  const site = await prisma.site.findFirstOrThrow({ select: { id: true, name: true } });
  const actor = await prisma.userAccount.findFirstOrThrow({
    where: { roleCode: 'ADMIN', status: 'ACTIVE' },
    select: { id: true, fullName: true },
    orderBy: { createdAt: 'asc' },
  });

  const all: Existing[] = await prisma.workResource.findMany({
    where: { siteId: site.id },
    select: {
      id: true, code: true, name: true, capacityRole: true, resourceCategory: true, retiredAt: true,
      schedulingEnabled: true, physicalPosition: true, serviceCapabilities: { select: { capability: true } },
    },
  }) as unknown as Existing[];
  const byCode = new Map(all.map((r) => [r.code, r]));

  console.log(`\nCR-2026-119 — resource baseline for ${site.name}`);
  console.log(COMMIT ? '  MODE: COMMIT\n' : '  MODE: DRY RUN (pass --commit to apply)\n');

  // ---------------------------------------------------------------------------
  // Fresh or existing? The question that decides whether lifts are created.
  // ---------------------------------------------------------------------------
  const legacyLifts = LEGACY_LIFT_CODES.map((c) => byCode.get(c)).filter((r): r is Existing => !!r && !r.retiredAt);
  const fresh = legacyLifts.length === 0 && !LIFTING_STATIONS.some((s) => byCode.has(s.code));

  console.log('  Lifting stations (photographs: four two-post, two runway)');
  console.log('  ' + '-'.repeat(74));
  if (fresh) {
    out('No lift records exist on this database — a fresh deployment. The six stations');
    out('the photographs establish will be created, keyed by physical position.');
    for (const s of LIFTING_STATIONS) {
      if (!COMMIT) { out(`${s.code.padEnd(10)} would CREATE "${s.name}"  liftType=${s.liftType}  PRIMARY + GENERAL  (${s.position})`); continue; }
      const created = await admin.create(
        site.id,
        {
          code: s.code,
          name: s.name,
          resourceCategory: 'BAY',
          liftType: s.liftType,
          // Rating unverified (§2). STANDARD is the conservative default; a manager
          // raises it to HEAVY on the Resources & Bays screen once the plate is read.
          maxVehicleWeight: 'STANDARD',
          requiresMechanic: true,
          supportsSedan: true,
          supportsSuv: true,
          schedulingEnabled: true,
          capacity: 1,
          capacityRole: 'PRIMARY_SERVICE_POSITION',
          physicalPosition: s.position,
          notes: 'Created from the photographic audit (CR-2026-119). Lift rating NOT verified — confirm the plate before raising the weight class.',
        },
        actor.id,
      );
      await admin.setCapabilities(created.id, ['GENERAL'], actor.id);
      out(`${s.code.padEnd(10)} CREATED "${s.name}"  liftType=${s.liftType}  PRIMARY + GENERAL  (${s.position})`);
    }
  } else {
    out('Lift records already exist. They are NOT altered: which record is which');
    out('physical lift is unconfirmed (§2), and a script must not guess it.');
    for (const r of legacyLifts) {
      const where = r.physicalPosition ? `at "${r.physicalPosition}"` : 'position NOT recorded';
      out(`${r.code.padEnd(10)} ${String(r.capacityRole).padEnd(26)} ${r.name.padEnd(16)} ${where}`);
    }
    out('→ Link each on Setup → Resources & Bays → Confirm Work Positions by typing its');
    out('  position ("Position 3"). Five records claim a heavy lift; the building has four.');
  }

  // ---------------------------------------------------------------------------
  // Ground-level positions: exist, unconfirmed use, zero capacity.
  // ---------------------------------------------------------------------------
  console.log('\n  Ground-level positions (photographs: 5 and 7, no fixed lift seen)');
  console.log('  ' + '-'.repeat(74));
  for (const g of GROUND_POSITIONS) {
    const existing = byCode.get(g.code);
    if (existing) { out(`${g.code.padEnd(10)} exists (${existing.capacityRole}) — left as is`); continue; }
    // On an existing database these may already be BAY-06/07, LT-01/02 or OVF-01/02
    // under another name. Creating a second record for the same floor would be
    // the double-count the directive forbids (§3), so they are only created fresh.
    if (!fresh) { out(`${g.code.padEnd(10)} not created — may already be BAY-06/07, LT-01/02 or OVF-01/02; confirm on the walk`); continue; }
    if (!COMMIT) { out(`${g.code.padEnd(10)} would CREATE "${g.name}" UNVERIFIED, no lift, no capacity  (${g.position})`); continue; }
    await admin.create(
      site.id,
      {
        code: g.code,
        name: g.name,
        resourceCategory: 'BAY',
        liftType: null,
        maxVehicleWeight: 'STANDARD',
        requiresMechanic: true,
        schedulingEnabled: true,
        capacity: 1,
        capacityRole: 'UNVERIFIED',
        physicalPosition: g.position,
        notes: 'Covered ground-level position seen on the photographic audit (CR-2026-119). Operational use unconfirmed; contributes no capacity until classified.',
      },
      actor.id,
    );
    out(`${g.code.padEnd(10)} CREATED "${g.name}" UNVERIFIED  (${g.position})`);
  }

  // ---------------------------------------------------------------------------
  // The wash bay — confirmed by management; a capability of its own.
  // ---------------------------------------------------------------------------
  console.log('\n  Vehicle wash bay (management confirmed a dedicated wash area)');
  console.log('  ' + '-'.repeat(74));
  const wash = byCode.get('PWASH-01');
  if (!wash) {
    if (!COMMIT) { out('PWASH-01   would CREATE "Vehicle Wash Bay"  POWER_WASH  PRIMARY + CLEANING  (Wash area)'); }
    else {
      const created = await admin.create(
        site.id,
        {
          code: 'PWASH-01', name: 'Vehicle Wash Bay', resourceCategory: 'POWER_WASH', liftType: null,
          maxVehicleWeight: 'HEAVY', requiresMechanic: false, schedulingEnabled: true, capacity: 1,
          capacityRole: 'PRIMARY_SERVICE_POSITION', physicalPosition: 'Wash area',
          notes: 'Dedicated washing location (CR-2026-119 §5). One vehicle at a time. Cleaning only; never mechanical work.',
        },
        actor.id,
      );
      await admin.setCapabilities(created.id, ['CLEANING'], actor.id);
      out('PWASH-01   CREATED "Vehicle Wash Bay"  PRIMARY + CLEANING');
    }
  } else if (wash.retiredAt) {
    out('PWASH-01   is RETIRED — reactivate it deliberately rather than from a script.');
  } else {
    const changes: string[] = [];
    if (wash.name === 'Power Wash') changes.push('name "Power Wash" -> "Vehicle Wash Bay"');
    if (String(wash.capacityRole) !== 'PRIMARY_SERVICE_POSITION') changes.push(`role ${wash.capacityRole} -> PRIMARY_SERVICE_POSITION`);
    const caps = wash.serviceCapabilities.map((c) => c.capability).sort();
    if (JSON.stringify(caps) !== JSON.stringify(['CLEANING'])) changes.push(`capabilities [${caps.join(',') || 'none'}] -> [CLEANING]`);
    if (!wash.physicalPosition) changes.push('position -> "Wash area"');
    if (changes.length === 0) out('PWASH-01   already correct');
    else if (!COMMIT) out(`PWASH-01   would UPDATE: ${changes.join('; ')}`);
    else {
      await admin.update(wash.id, {
        ...(wash.name === 'Power Wash' ? { name: 'Vehicle Wash Bay' } : {}),
        capacityRole: 'PRIMARY_SERVICE_POSITION',
        ...(wash.physicalPosition ? {} : { physicalPosition: 'Wash area' }),
      }, actor.id);
      // Replace, not union: a wash bay that also carried GENERAL would be offered
      // mechanical work, which is exactly what §5 forbids.
      await admin.setCapabilities(wash.id, ['CLEANING'], actor.id);
      out(`PWASH-01   UPDATED: ${changes.join('; ')}`);
    }
  }

  // ---------------------------------------------------------------------------
  // The press — equipment, zero vehicle capacity, a status that can be set by hand.
  // ---------------------------------------------------------------------------
  console.log('\n  Bushing/bearings press (management confirmed, left-hand corner)');
  console.log('  ' + '-'.repeat(74));
  const press = byCode.get('PRESS-01');
  if (press) {
    if (String(press.capacityRole) === 'SUPPORT_EQUIPMENT') out('PRESS-01   already SUPPORT_EQUIPMENT');
    else if (!COMMIT) out(`PRESS-01   would set ${press.capacityRole} -> SUPPORT_EQUIPMENT`);
    else { await admin.update(press.id, { capacityRole: 'SUPPORT_EQUIPMENT' }, actor.id); out('PRESS-01   SUPPORT_EQUIPMENT'); }
  } else if (!COMMIT) {
    out('PRESS-01   would CREATE "Bushing/Bearings Press"  SUPPORT_EQUIPMENT, not schedulable, zero vehicle capacity  (Press corner)');
  } else {
    await admin.create(
      site.id,
      {
        code: 'PRESS-01', name: 'Bushing/Bearings Press', resourceCategory: 'BAY', liftType: null,
        maxVehicleWeight: null, requiresMechanic: true, showOnDispatchBoard: true,
        // Not a place a vehicle goes: the scheduler must never offer it, and it
        // must never add to any count. Its only job is a status someone can set.
        schedulingEnabled: false, capacity: 1, capacityRole: 'SUPPORT_EQUIPMENT',
        physicalPosition: 'Press corner',
        notes: 'Specialised workshop equipment (CR-2026-119 §6). Supports mechanical work in a bay; is not a bay. Set its status here when it is down.',
      },
      actor.id,
    );
    out('PRESS-01   CREATED "Bushing/Bearings Press"  SUPPORT_EQUIPMENT');
  }

  // ---------------------------------------------------------------------------
  // External machine shop — distinct from the on-site press, and not capacity.
  // ---------------------------------------------------------------------------
  console.log('\n  External machine shop');
  console.log('  ' + '-'.repeat(74));
  const ext = byCode.get('MSHOP-EXT');
  if (!ext) out('MSHOP-EXT  not found (seeded normally) — nothing to do');
  else if (String(ext.capacityRole) === 'SUPPORT_EQUIPMENT' && String(ext.resourceCategory) === 'EXTERNAL') out('MSHOP-EXT  already EXTERNAL / SUPPORT_EQUIPMENT');
  else if (!COMMIT) out(`MSHOP-EXT  would set ${ext.capacityRole} -> SUPPORT_EQUIPMENT (category stays EXTERNAL; off-site work, zero on-site capacity)`);
  else { await admin.update(ext.id, { capacityRole: 'SUPPORT_EQUIPMENT' }, actor.id); out('MSHOP-EXT  SUPPORT_EQUIPMENT (EXTERNAL)'); }

  // ---------------------------------------------------------------------------
  // Jacks and stands — tools used at a position, never positions.
  // ---------------------------------------------------------------------------
  console.log('\n  Equipment (contributes zero — a decision, not an absence)');
  console.log('  ' + '-'.repeat(74));
  for (const code of SUPPORT_EQUIPMENT) {
    const r = byCode.get(code);
    if (!r) { out(`${code.padEnd(10)} not found`); continue; }
    if (String(r.capacityRole) === 'SUPPORT_EQUIPMENT') { out(`${code.padEnd(10)} already SUPPORT_EQUIPMENT`); continue; }
    if (!COMMIT) { out(`${code.padEnd(10)} would set ${r.capacityRole} -> SUPPORT_EQUIPMENT  ("${r.name}")`); continue; }
    await admin.update(r.id, { capacityRole: 'SUPPORT_EQUIPMENT' }, actor.id);
    out(`${code.padEnd(10)} SUPPORT_EQUIPMENT  ("${r.name}")`);
  }

  // ---------------------------------------------------------------------------
  // What is left for a person — printed, never guessed.
  // ---------------------------------------------------------------------------
  const touched = new Set<string>([
    ...LIFTING_STATIONS.map((s) => s.code), ...GROUND_POSITIONS.map((g) => g.code), ...LEGACY_LIFT_CODES,
    'PWASH-01', 'PRESS-01', 'MSHOP-EXT', ...SUPPORT_EQUIPMENT,
  ]);
  const untouched = all.filter((r) => !r.retiredAt && !touched.has(r.code));
  console.log('\n  Left for the walk to decide — a script must not');
  console.log('  ' + '-'.repeat(74));
  for (const r of untouched) out(`${r.code.padEnd(10)} ${String(r.capacityRole).padEnd(18)} ${r.name}`);
  out('BAY-04 Mobile Lift / BAY-05 Power Jack: equipment unless each is its own usable position.');
  out('LT-01/02, OVF-01/02: may be positions 5 and 7 under other names — one place, one record.');
  out('Wheel alignment: no station confirmed; TIR-02 stays unbookable until one is.');

  // ---------------------------------------------------------------------------
  // The derived figures, read back — and the one that must not move.
  // ---------------------------------------------------------------------------
  const verified = await prisma.workResource.findMany({
    where: { siteId: site.id, retiredAt: null, isActive: true, schedulingEnabled: true, capacityRole: { in: ['PRIMARY_SERVICE_POSITION', 'OVERFLOW_SERVICE_POSITION'] } },
    select: { code: true, capacity: true, resourceCategory: true, operationalStatus: { select: { status: true } } },
  });
  const usable = verified.filter((r) => (r.operationalStatus?.status ?? 'AVAILABLE') === 'AVAILABLE');
  const service = usable.filter((r) => String(r.resourceCategory) !== 'POWER_WASH').reduce((n, r) => n + r.capacity, 0);
  const washCount = usable.filter((r) => String(r.resourceCategory) === 'POWER_WASH').reduce((n, r) => n + r.capacity, 0);
  const mode = await prisma.businessRuleConfig.findFirst({ where: { ruleKey: 'booking_capacity_mode', effectiveTo: null }, select: { valueJson: true } });
  const fixedLimit = await prisma.businessRuleConfig.findFirst({ where: { ruleKey: 'booking_max_concurrent_appointments', effectiveTo: null }, select: { valueJson: true } });
  console.log('\n  ' + '='.repeat(74));
  console.log(`  Derived verified SERVICE positions: ${service}   (wash positions, counted apart: ${washCount})`);
  console.log(`  Public booking: mode ${JSON.stringify(mode?.valueJson ?? 'FIXED')}, fixed limit ${JSON.stringify(fixedLimit?.valueJson ?? null)} — unchanged by this script (§9).`);
  console.log('  ' + '='.repeat(74) + '\n');
  if (!COMMIT) console.log('  Nothing was written. Re-run with --commit to apply.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
