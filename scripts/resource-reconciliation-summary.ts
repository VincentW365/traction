/**
 * CR-2026-108 — the Stage 5C entry gate, on the command line.
 *
 *   pnpm resources:summary
 *
 * Run this after the physical walk. It reads the database and writes nothing:
 * no classification, no linking, no capacity number invented anywhere.
 *
 * It prints the thirteen items management asked for, and — the part that matters
 * most — it prints the capability pools WITHOUT adding them up, because a bay that
 * can do three kinds of work is one vehicle at a time, not three.
 */
import { PrismaClient } from '@prisma/client';
import { ReconciliationSummaryService } from '../apps/api/src/modules/resources/reconciliation-summary.service';
import type { PrismaService } from '../apps/api/src/infrastructure/prisma/prisma.service';

const prisma = new PrismaClient();
const rule = (t: string) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const num = (s: string | number, n: number) => String(s).padStart(n);

async function main() {
  const siteArg = process.argv.find((a) => a.startsWith('--site='))?.split('=')[1];
  const service = new ReconciliationSummaryService(prisma as unknown as PrismaService);
  const s = await service.summary(siteArg);

  console.log('\n============================================================');
  console.log('  RESOURCE RECONCILIATION SUMMARY');
  console.log(`  ${new Date(s.generatedAt).toLocaleString()}`);
  console.log('============================================================');

  // --- verdict first: it changes how everything below should be read --------
  if (s.readyForStage5C) {
    console.log('\n  STATUS: READY — the reconciled inventory can be Stage 5C input.\n');
  } else {
    console.log('\n  STATUS: NOT READY — the physical walk is incomplete.\n');
    s.blockers.forEach((b, i) => console.log(`    ${i + 1}. ${b}`));
    console.log('\n  Every count below therefore describes part of the Service Centre.');
  }

  rule('1-5, 11 — position census');
  const p = s.positions;
  console.log(`  Verified primary service positions   ${num(p.verifiedPrimary, 4)}`);
  console.log(`  Verified overflow positions          ${num(p.verifiedOverflow, 4)}`);
  console.log(`  Support equipment (never capacity)   ${num(p.supportEquipment, 4)}`);
  console.log(`  Placeholders (not built yet)         ${num(p.placeholders, 4)}`);
  console.log(`  Temporarily unavailable *            ${num(p.temporarilyUnavailable, 4)}`);
  console.log(`  Still UNVERIFIED                     ${num(p.unverified, 4)}`);
  console.log(`  Retired (history kept)               ${num(p.retired, 4)}`);
  console.log(`  ---`);
  console.log(`  Confirmed positions usable NOW       ${num(p.activeNow, 4)}`);
  console.log('\n  * a status, not a role: a maintenance bay is still counted as the');
  console.log('    kind of position it is, and returns to the active figure when fixed.');

  rule('6, 7 — capability pools (NOT additive)');
  if (s.capabilities.length === 0) {
    console.log('  No confirmed position carries any capability yet.');
  } else {
    console.log(`  ${pad('Capability', 14)}${num('Verified', 9)}${num('Now', 5)}${num('Only this', 11)}${num('Shared', 8)}  Resources`);
    for (const c of s.capabilities) {
      const tag = c.isNamedType ? '' : '  (additional)';
      console.log(
        `  ${pad(c.capability, 14)}${num(c.verifiedPositions, 9)}${num(c.availableNow, 5)}` +
          `${num(c.exclusivePositions, 11)}${num(c.sharedPositions, 8)}  ${c.resources.join(', ') || '—'}${tag}`,
      );
    }
  }
  const o = s.capabilityOverlap;
  console.log(`\n  Sum of the pool column ......... ${o.sumOfPoolCounts}   <- NOT shop capacity`);
  console.log(`  Distinct physical positions .... ${o.distinctPhysicalPositions}   <- the real ceiling`);
  console.log(`  Positions carrying >1 capability ${o.multiCapabilityPositions}`);
  console.log(`\n  ${o.note.replace(/\. /g, '.\n  ')}`);

  rule('8 — vehicle restrictions');
  if (s.vehicleRestrictions.length === 0) {
    console.log('  None — every resource accepts both vehicle classes.');
  } else {
    for (const v of s.vehicleRestrictions) {
      console.log(`  ${pad(v.code, 12)} ${pad(v.restriction, 24)} ${v.name}`);
      console.log(`               ${v.detail}`);
    }
  }

  rule('9 — legacy bay records not yet accounted for');
  if (s.unresolvedLegacyBays.length === 0) {
    console.log('  None — every legacy bay is either linked to its resource or recorded as history.');
  } else {
    for (const b of s.unresolvedLegacyBays) {
      const flag = b.historicalAssignments > 0 ? '  <- carries real job history' : '';
      console.log(`  ${pad(b.code, 12)} ${pad(b.bayType, 12)} ${pad(b.status, 10)} ${num(b.historicalAssignments, 5)} jobs${flag}`);
    }
    console.log('\n  Each needs EITHER a link to the resource that is that same physical position,');
    console.log('  OR a note saying it is history (demolished, absorbed, replaced, retired).');
    console.log('  Do not invent a link to clear this list — a made-up link is a fact the');
    console.log('  resource-aware engine would go on to reason from.');
  }

  if (s.dispositionedLegacyBays.length > 0) {
    rule('9b — legacy bays resolved WITHOUT a link');
    for (const b of s.dispositionedLegacyBays) {
      console.log(`  ${pad(b.code, 12)} ${pad(b.disposition, 17)} ${num(b.historicalAssignments, 5)} jobs kept  ${b.note ?? ''}`);
    }
    console.log('\n  Their assignments are untouched. Dispositioning records a fact about the');
    console.log('  building; it never edits history.');
  }

  rule('10 — expansion resources (no legacy counterpart)');
  console.log(`  ${s.expansion.note}\n`);
  if (s.expansion.resources.length === 0) {
    console.log('  None.');
  } else {
    for (const r of s.expansion.resources) {
      console.log(`  ${pad(r.code, 12)} ${pad(r.capacityRole, 26)} ${pad(r.capabilities.join('/') || '—', 22)} ${r.name}`);
    }
  }

  rule('12 — where Vehicle Cleaning happens');
  console.log(`  Verdict (from configuration): ${s.vehicleCleaning.verdict}`);
  console.log(`  ${s.vehicleCleaning.detail}`);
  const mc = s.vehicleCleaning.managementConfirmation;
  if (mc.open) {
    console.log(`\n  *** OPEN — MANAGEMENT CONFIRMATION REQUIRED (${mc.status}) ***`);
    console.log(`  Q: ${mc.question}`);
    console.log(`  If yes: ${mc.proposalIfDedicated}`);
    console.log('\n  This item does NOT close when the walk finishes. Classifying bays cannot');
    console.log('  answer it — the fix is a catalogue change, and that is management\'s call.');
  }

  rule('13 — bookable services with one position or none');
  if (s.singlePositionBookableServices.length === 0) {
    console.log('  None — every publicly bookable service has at least two verified positions.');
  } else {
    for (const svc of s.singlePositionBookableServices) {
      // Before the walk, a pool of zero says nobody has classified a bay. Saying
      // "cannot be fulfilled" there would be an alarm about the data dressed up
      // as an alarm about the shop.
      const verdict =
        svc.basis === 'INCOMPLETE_CONFIGURATION'
          ? 'no position CONFIRMED yet'
          : svc.severity === 'NO_POSITION'
            ? 'CANNOT BE FULFILLED'
            : 'single point of failure';
      console.log(
        `  ${pad(svc.code, 12)} ${pad(svc.capability, 12)} ${num(svc.verifiedPositions, 3)} position(s)  ` +
          `${pad(verdict, 24)} — ${svc.name}`,
      );
    }
    if (s.singlePositionBookableServices.every((x) => x.basis === 'INCOMPLETE_CONFIGURATION')) {
      console.log('\n  These reflect the unfinished walk, not a shop that cannot do the work.');
      console.log('  Re-run after classifying the bays; the list should shrink to the real cases.');
    } else {
      console.log('\n  booking_max_concurrent_appointments is 2, so two customers can hold the');
      console.log('  same slot. For any service above, both could need the same one position.');
    }
  }

  console.log('\n============================================================');
  console.log('  Nothing was written. No capacity number was inferred.');
  console.log('============================================================\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
