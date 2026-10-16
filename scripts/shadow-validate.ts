/**
 * CR-2026-108 Stage 5C — shadow validation.
 *
 *   pnpm booking:shadow-validate            # run and record
 *   pnpm booking:shadow-validate --no-write # run and report only
 *
 * Runs the FIXED and RESOURCE_AWARE models side by side over every publicly
 * bookable service, records the disagreements, and stamps the result against the
 * CURRENT resource configuration.
 *
 * That stamp is what the production preflight checks. A validation run from last
 * week says nothing about a shop that has since commissioned a bay, so the
 * fingerprint has to match or the preflight treats the configuration as unvalidated.
 *
 * Nothing here touches production behaviour: the fixed model still decides, and
 * this only records where the other one would have disagreed.
 */
import { PrismaClient } from '@prisma/client';
import { ResourceAvailabilityService, primaryCapability } from '../apps/api/src/modules/scheduling/availability/resource-availability.service';
import { ShadowComparisonService } from '../apps/api/src/modules/scheduling/availability/shadow-comparison.service';
import { BookingAvailabilityService } from '../apps/api/src/modules/scheduling/availability/booking-availability.service';
import { SERVICE_DURATION_SELECT } from '../apps/api/src/modules/scheduling/availability/service-duration';
import { EtaService } from '../apps/api/src/modules/scheduling/eta/eta.service';
import { SHADOW_VALIDATION_KEY } from '../apps/api/src/modules/resources/resource-readiness.service';
import type { PrismaService } from '../apps/api/src/infrastructure/prisma/prisma.service';

const prisma = new PrismaClient();
const WRITE = !process.argv.includes('--no-write');
const DAYS = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 14);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const num = (s: string | number, n: number) => String(s).padStart(n);

async function main() {
  const p = prisma as unknown as PrismaService;
  const eta = new EtaService(p);
  const availability = new BookingAvailabilityService(p, eta);
  const resources = new ResourceAvailabilityService(p);
  const shadow = new ShadowComparisonService(p, resources);

  const site = await prisma.site.findFirstOrThrow({ select: { id: true, name: true, timezone: true } });
  const services = await prisma.serviceType.findMany({
    where: { bookableOnline: true, isActive: true },
    // CR-2026-121 — SERVICE_DURATION_SELECT, not a hand-written list: since the
    // CR-2026-111 duration consolidation the resolver refuses a service loaded
    // without its vehicle-class columns, and this script had silently been
    // failing on its first service ever since. Same select the public API uses.
    select: { ...SERVICE_DURATION_SELECT, customerFacingName: true, requiredBayType: true },
    orderBy: { code: 'asc' },
  });

  console.log(`\nCR-2026-108 — shadow validation (${site.name}, ${DAYS} days)\n`);
  if (services.length === 0) {
    console.log('  No publicly bookable service. Nothing to validate.\n');
    return;
  }

  const rules = await availability.loadRules(site.id);
  let totals = { slotsCompared: 0, oversold: 0, undersold: 0, incomplete: 0, written: 0 };
  let fingerprint = '';

  console.log(`  ${pad('Service', 12)}${pad('Needs', 12)}${num('Slots', 7)}${num('Agree', 7)}${num('Over', 6)}${num('Under', 7)}${num('Incompl', 9)}  Positions`);
  console.log('  ' + '-'.repeat(88));

  for (const svc of services) {
    const { decision, ...context } = await availability.availabilityDecision(site, [svc], {
      days: DAYS,
      audience: 'CUSTOMER',
      rules,
    });

    const bounds = slotWindow(decision);
    const snapshot = await resources.snapshot(site.id, bounds ?? { from: new Date(), to: new Date() }, {
      defaultDurationMinutes: rules.eta.defaultDurationMinutes,
    });
    fingerprint = snapshot.fingerprint;

    const capability = primaryCapability([svc.requiredBayType]);
    const run = shadow.compare(decision, snapshot, { requiredCapability: capability, vehicleClass: null });

    if (WRITE) {
      const { written } = await shadow.record(site.id, run, {
        serviceCodes: [svc.code],
        plannedMinutes: context.plannedMinutes,
        vehicleClass: null,
        source: 'VALIDATION',
      });
      totals.written += written;
    }
    totals.slotsCompared += run.summary.slotsCompared;
    totals.oversold += run.summary.oversold;
    totals.undersold += run.summary.undersold;
    totals.incomplete += run.summary.incomplete;

    console.log(
      `  ${pad(svc.code, 12)}${pad(capability ?? '(any)', 12)}${num(run.summary.slotsCompared, 7)}${num(run.summary.agree, 7)}` +
        `${num(run.summary.oversold, 6)}${num(run.summary.undersold, 7)}${num(run.summary.incomplete, 9)}  ${run.summary.eligiblePositions}`,
    );
  }

  console.log('  ' + '-'.repeat(88));
  // The four columns partition the slots, so agreement is the remainder — an
  // INCOMPLETE slot is not an agreement and must not be counted as one.
  const agreed = totals.slotsCompared - totals.oversold - totals.undersold - totals.incomplete;
  console.log(
    `  ${pad('TOTAL', 24)}${num(totals.slotsCompared, 7)}${num(agreed, 7)}` +
      `${num(totals.oversold, 6)}${num(totals.undersold, 7)}${num(totals.incomplete, 9)}`,
  );

  console.log('\n  Over  = the fixed limit offered a slot no eligible position could cover.');
  console.log('          This is the dangerous direction: a customer is promised work the shop cannot do.');
  console.log('  Under = the fixed limit refused a slot where positions were free.');
  console.log('          Real capacity sitting behind a global number.');
  console.log('  Incompl = the resource model could not evaluate. A configuration gap, NOT a capacity finding.');

  if (WRITE) {
    const record = {
      fingerprint,
      at: new Date().toISOString(),
      services: services.map((s) => s.code),
      slotsCompared: totals.slotsCompared,
      oversold: totals.oversold,
      undersold: totals.undersold,
      incomplete: totals.incomplete,
    };
    const existing = await prisma.businessRuleConfig.findFirst({ where: { ruleKey: SHADOW_VALIDATION_KEY, effectiveTo: null }, select: { id: true } });
    if (existing) await prisma.businessRuleConfig.update({ where: { id: existing.id }, data: { effectiveTo: new Date() } });
    await prisma.businessRuleConfig.create({
      data: {
        ruleKey: SHADOW_VALIDATION_KEY,
        siteId: site.id,
        valueJson: record,
        notes: 'CR-2026-108 Stage 5C shadow validation run',
      },
    });
    console.log(`\n  Recorded ${totals.written} disagreement row(s); validation stamped against configuration ${fingerprint}.`);
    console.log('  The production preflight checks that stamp against the live configuration.\n');
  } else {
    console.log('\n  --no-write: nothing recorded.\n');
  }
}

function slotWindow(decision: { days: Array<{ slots: Array<{ startAt: string; endAt: string }> }> }) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const d of decision.days) {
    for (const s of d.slots) {
      min = Math.min(min, new Date(s.startAt).getTime());
      max = Math.max(max, new Date(s.endAt).getTime());
    }
  }
  return Number.isFinite(min) ? { from: new Date(min), to: new Date(max) } : null;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
