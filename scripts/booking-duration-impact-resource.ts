/**
 * CR-2026-108 §20 — Stage 4F re-run, now against physical resources.
 *
 *     pnpm booking:duration-impact-resource
 *
 * READ-ONLY. It never writes and never changes `appointment_duration_source`.
 * The two duration models are compared by handing the SAME production
 * availability service two in-memory rule sets; production stays on DEFAULT.
 *
 * WHY RE-RUN IT
 *
 * Stage 4F concluded HOLD on switching to CATALOGUE. The finding was that short
 * services gained +83% saturation — but that was measured against a GLOBAL
 * CEILING OF 2, a policy guard nobody had validated against the building. The
 * question management asked is whether that concern survives now that eight
 * confirmed physical positions exist.
 *
 * So each configuration is measured twice: once against the fixed limit that
 * decides bookings today, and once against the resource model, which knows how
 * many bays can actually do the work.
 */
import { PrismaClient } from '@prisma/client';
import { BookingAvailabilityService } from '../apps/api/src/modules/scheduling/availability/booking-availability.service';
import { EtaService } from '../apps/api/src/modules/scheduling/eta/eta.service';
import { ResourceAvailabilityService, primaryCapability } from '../apps/api/src/modules/scheduling/availability/resource-availability.service';
import { ShadowComparisonService } from '../apps/api/src/modules/scheduling/availability/shadow-comparison.service';
import type { PrismaService } from '../apps/api/src/infrastructure/prisma/prisma.service';

const DAYS = 14;
const PILOT = ['OIL-01', 'TIR-01', 'BRK-01', 'TIR-02', 'INSP-01', 'CLEAN-01'];

const prisma = new PrismaClient();
const pct = (a: number, b: number) => (b === 0 ? '--' : `${a > b ? '+' : ''}${Math.round(((a - b) / b) * 1000) / 10}%`);
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const rpad = (s: unknown, n: number) => String(s).padStart(n);

interface Measured {
  code: string;
  label: string;
  capability: string | null;
  minutes: number;
  fixedSlots: number;
  resourceSlots: number;
  resourceIncomplete: number;
  eligiblePositions: number;
}

async function main(): Promise<void> {
  const p = prisma as unknown as PrismaService;
  const site = await prisma.site.findFirstOrThrow({ where: { isActive: true }, select: { id: true, timezone: true } });
  const eta = new EtaService(p);
  const avail = new BookingAvailabilityService(p, eta);
  const resources = new ResourceAvailabilityService(p);
  const shadow = new ShadowComparisonService(p, resources);
  const base = await avail.loadRules(site.id);

  const asDefault = { ...base, booking: { ...base.booking, durationSource: 'DEFAULT' as const } };
  const asCatalogue = { ...base, booking: { ...base.booking, durationSource: 'CATALOGUE' as const } };

  const services = await prisma.serviceType.findMany({
    where: { code: { in: PILOT } },
    select: { code: true, name: true, customerFacingName: true, baseDurationMinutes: true, requiredBayType: true },
  });

  console.log('\nCR-2026-108 §20 — Stage 4F re-run against the resource model');
  console.log(`  site ${site.timezone} · ${DAYS} days · fixed limit ${base.eta.capacity} · default ${base.eta.defaultDurationMinutes}m`);
  console.log(`  production duration source: ${base.booking.durationSource} (unchanged by this analysis)`);

  // One snapshot of the shop, reused for both duration models so a difference
  // between them is never an artefact of the configuration shifting underneath.
  const probe = await avail.availabilityDecision(site, services.slice(0, 1), { days: DAYS, audience: 'CUSTOMER', rules: asDefault });
  const bounds = slotWindow(probe.decision) ?? { from: new Date(), to: new Date() };
  const snapshot = await resources.snapshot(site.id, bounds, { defaultDurationMinutes: base.eta.defaultDurationMinutes });

  console.log(`  confirmed positions ${snapshot.activePositions} · unclassified ${snapshot.unverifiedResourceCount} · configuration ${snapshot.fingerprint}\n`);

  async function measure(rules: typeof base): Promise<Measured[]> {
    const out: Measured[] = [];
    for (const svc of services) {
      const { decision, plannedMinutes } = await avail.availabilityDecision(site, [svc], {
        days: DAYS,
        audience: 'CUSTOMER',
        rules,
      });
      const capability = primaryCapability([svc.requiredBayType]);
      const run = shadow.compare(decision, snapshot, { requiredCapability: capability, vehicleClass: null });
      const fixedSlots = decision.days.reduce((n, d) => n + d.slots.filter((s) => s.available).length, 0);
      const resourceSlots = run.days.reduce(
        (n, d) => n + d.slots.filter((s) => s.shadow.status === 'AVAILABLE').length,
        0,
      );
      out.push({
        code: svc.code,
        label: svc.customerFacingName?.trim() || svc.name,
        capability,
        minutes: plannedMinutes,
        fixedSlots,
        resourceSlots,
        resourceIncomplete: run.summary.incomplete,
        eligiblePositions: run.summary.eligiblePositions,
      });
    }
    return out;
  }

  const def = await measure(asDefault);
  const cat = await measure(asCatalogue);

  // --- 1. offered slots, both models -----------------------------------------
  console.log('--- 1. Bookable start slots, next 14 days ------------------------------------');
  console.log(
    `${pad('Service', 30)}${rpad('needs', 11)}${rpad('DEF m', 7)}${rpad('CAT m', 7)}` +
      `${rpad('FIXED def', 11)}${rpad('FIXED cat', 11)}${rpad('%', 8)}${rpad('RES def', 9)}${rpad('RES cat', 9)}${rpad('%', 8)}`,
  );
  for (let i = 0; i < def.length; i++) {
    const d = def[i];
    const c = cat[i];
    const resPct = d.resourceIncomplete > 0 || c.resourceIncomplete > 0 ? 'n/a' : pct(c.resourceSlots, d.resourceSlots);
    console.log(
      `${pad(d.label.slice(0, 29), 30)}${rpad(d.capability ?? '(any)', 11)}${rpad(d.minutes, 7)}${rpad(c.minutes, 7)}` +
        `${rpad(d.fixedSlots, 11)}${rpad(c.fixedSlots, 11)}${rpad(pct(c.fixedSlots, d.fixedSlots), 8)}` +
        `${rpad(d.resourceIncomplete > 0 ? '—' : d.resourceSlots, 9)}${rpad(c.resourceIncomplete > 0 ? '—' : c.resourceSlots, 9)}${rpad(resPct, 8)}`,
    );
  }
  console.log('\n  "—" = the resource model could not evaluate: no position is configured for that');
  console.log('  kind of work yet. A configuration gap, not a capacity finding.');

  // --- 2. saturation ----------------------------------------------------------
  // The number Stage 4F actually turned on: not how many slots exist, but how
  // much of the day a booking consumes once it is placed.
  console.log('\n--- 2. Saturation — share of the working day one booking consumes -------------');
  console.log(`${pad('Service', 30)}${rpad('DEF m', 8)}${rpad('CAT m', 8)}${rpad('change', 10)}  interpretation`);
  for (let i = 0; i < def.length; i++) {
    const d = def[i];
    const c = cat[i];
    const change = pct(c.minutes, d.minutes);
    const note =
      c.minutes < d.minutes
        ? `a ${c.minutes}m job stops blocking ${d.minutes - c.minutes}m of a position`
        : c.minutes > d.minutes
          ? `holds a position ${c.minutes - d.minutes}m longer`
          : 'unchanged';
    console.log(`${pad(d.label.slice(0, 29), 30)}${rpad(d.minutes, 8)}${rpad(c.minutes, 8)}${rpad(change, 10)}  ${note}`);
  }

  // --- 3. the question management asked --------------------------------------
  const shortServices = def.filter((d, i) => cat[i].minutes < d.minutes);
  const evaluable = def.filter((d) => d.resourceIncomplete === 0);
  const worstPool = Math.min(...evaluable.map((d) => d.eligiblePositions));

  console.log('\n--- 3. Does the +83% short-service concern survive? ---------------------------');
  console.log(`\n  Stage 4F measured saturation against a GLOBAL CEILING OF 2 — a policy guard`);
  console.log(`  nobody had validated. The shop now has ${snapshot.activePositions} confirmed physical positions.`);
  console.log(`\n  Under DEFAULT every booking holds a position for ${base.eta.defaultDurationMinutes} minutes regardless of the work.`);
  console.log(`  Under CATALOGUE ${shortServices.length} of ${def.length} pilot services shorten:`);
  for (const d of shortServices) {
    const c = cat.find((x) => x.code === d.code)!;
    console.log(`    ${pad(d.label.slice(0, 28), 29)} ${d.minutes}m -> ${c.minutes}m`);
  }
  console.log(`\n  With ${snapshot.activePositions} positions rather than 2, the same saturation increase is spread`);
  console.log(`  across four times the physical capacity. What that does NOT resolve:`);
  // Careful with this one: "the same single bay" is only true when the pool is
  // actually one, and saying it of a pool of eight would overstate the risk.
  const poolNote =
    worstPool <= 1
      ? `run on a SINGLE eligible position, and a shorter duration puts more bookings\n      through that one bay per day, not fewer.`
      : `run on as few as ${worstPool} eligible positions. Shorter durations raise the rate of\n      bookings per position, so the pressure lands wherever the pool is smallest.`;
  console.log(`\n    - Specialty pools, which are where the real ceiling is. Evaluable services`);
  console.log(`      ${Number.isFinite(worstPool) ? poolNote : 'cannot be measured — no specialty pool is configured.'}`);
  console.log(`    - ${def.length - evaluable.length} of ${def.length} pilot services cannot be evaluated at all: no position carries`);
  console.log(`      ${def.filter((d) => d.resourceIncomplete > 0).map((d) => d.capability).join(', ')} yet.`);
  console.log(`    - The fixed limit of ${base.eta.capacity} still decides what customers are offered, so`);
  console.log(`      switching durations today changes throughput against THAT number, not against ${snapshot.activePositions}.`);

  console.log('\n--- RECOMMENDATION ------------------------------------------------------------');
  if (def.length - evaluable.length > 0) {
    console.log('\n  HOLD — unchanged, but for a different and narrower reason than Stage 4F gave.');
    console.log('');
    console.log('  The eight confirmed general positions genuinely do weaken the original');
    console.log('  concern: a +83% saturation increase against a ceiling of 2 is a different');
    console.log('  proposition from the same increase against 8.');
    console.log('');
    console.log('  But the services that shorten most under CATALOGUE are the specialty ones,');
    console.log(`  and ${def.length - evaluable.length} of the six still have no configured position at all. Switching`);
    console.log('  durations now would increase the rate of bookings flowing toward pools whose');
    console.log('  size nobody has established. That is not a bigger version of the old risk —');
    console.log('  it is an unmeasured one.');
    console.log('');
    console.log('  Re-run this after the specialty capabilities are assigned. If each has two or');
    console.log('  more positions, the case for CATALOGUE becomes straightforward.');
  } else {
    console.log('\n  Every pilot service is now evaluable against real positions. Compare the');
    console.log('  RES columns above: where they move together with FIXED, the duration change is');
    console.log('  safe; where RES is flat while FIXED rises, the extra bookings have nowhere to go.');
  }
  console.log('\n  Nothing was changed. `appointment_duration_source` remains', base.booking.durationSource, '\n');
}

function slotWindow(decision: { days: Array<{ slots: Array<{ startAt: string; endAt: string }> }> }) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const d of decision.days) for (const s of d.slots) {
    min = Math.min(min, new Date(s.startAt).getTime());
    max = Math.max(max, new Date(s.endAt).getTime());
  }
  return Number.isFinite(min) ? { from: new Date(min), to: new Date(max) } : null;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
