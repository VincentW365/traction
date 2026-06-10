/**
 * Vehicle classification backfill (CR-2026-008).
 *
 *   (default)          DRY-RUN — counts-only report. NO DB writes.
 *   --commit           Create/refresh PENDING_REVIEW VehicleClassification rows
 *                      with advisory make/model suggestions. Idempotent (upsert
 *                      by vehicleId).
 *   --rollback         DRY-RUN of the rollback (counts only). Add --commit to
 *                      actually delete ONLY unreviewed advisory rows
 *                      (status PENDING_REVIEW AND reviewedAt IS NULL).
 *   --limit N          cap the number of vehicles processed (backfill only)
 *
 * GUARDRAILS:
 *  - NEVER writes Vehicle.serviceClass / weightClass (operational fields stay
 *    untouched — vehicles remain mobile-jack blocked until staff confirm).
 *  - Excludes historical placeholder vehicles (vehicleCode starts HIST-UNRESOLVED-).
 *  - Only seeds the review queue with advisory suggestions; status = PENDING_REVIEW.
 *  - Rollback preserves all CONFIRMED and reviewer-touched rows.
 *  - Touches only VehicleClassification rows — never vehicles/customers/jobs/
 *    queue/scheduling/ETA/reporting.
 *  - No PII printed (codes/classes only).
 */
import { PrismaClient } from '@prisma/client';
import { type VehicleSuggestionRule } from '../src/common/helpers/vehicle-classification';
import {
  planClassificationBackfill,
  planClassificationRollback,
} from '../src/modules/vehicles/classification.backfill';

const PLACEHOLDER_VEHICLE_CODE_PREFIX = 'HIST-UNRESOLVED-';

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const ROLLBACK = argv.includes('--rollback');
const limIdx = argv.indexOf('--limit');
const LIMIT = limIdx >= 0 ? parseInt(argv[limIdx + 1] ?? '', 10) || undefined : undefined;

async function runRollback(prisma: PrismaClient) {
  // Same predicate the deleteMany uses, computed from minimal rows for the report.
  const rows = await prisma.vehicleClassification.findMany({
    select: { status: true, reviewedAt: true },
  });
  const plan = planClassificationRollback(rows);

  let deleted = 0;
  if (COMMIT) {
    const res = await prisma.vehicleClassification.deleteMany({
      where: { status: 'PENDING_REVIEW', reviewedAt: null },
    });
    deleted = res.count;
  }

  console.warn('--- Vehicle classification ROLLBACK ---');
  console.warn(`mode:                 ${COMMIT ? 'COMMIT (delete)' : 'DRY-RUN (no writes)'}`);
  console.warn(`classification rows:  ${plan.total}`);
  console.warn(`deletable (PENDING + unreviewed): ${plan.deletable}`);
  console.warn(`preserved CONFIRMED:  ${plan.preservedConfirmed}`);
  console.warn(`preserved reviewed:   ${plan.preservedReviewed}`);
  console.warn(`rows deleted:         ${COMMIT ? deleted : 0}`);
  console.warn('NOTE: Vehicle.serviceClass and all CONFIRMED rows are never touched.');
}

async function main() {
  const prisma = new PrismaClient();
  try {
    if (ROLLBACK) {
      await runRollback(prisma);
      return;
    }
    const rules: VehicleSuggestionRule[] = (
      await prisma.vehicleWeightSuggestion.findMany()
    ).map((r) => ({
      makePattern: r.makePattern,
      modelPattern: r.modelPattern,
      yearFrom: r.yearFrom,
      yearTo: r.yearTo,
      suggestedWeightClass: r.suggestedWeightClass,
      suggestedServiceClass: r.suggestedServiceClass,
    }));

    // Live, unclassified vehicles only (exclude placeholders).
    const vehicles = await prisma.vehicle.findMany({
      where: {
        serviceClass: null,
        vehicleCode: { not: { startsWith: PLACEHOLDER_VEHICLE_CODE_PREFIX } },
      },
      select: {
        id: true,
        make: true,
        model: true,
        modelYear: true,
        classification: { select: { status: true } },
      },
      ...(LIMIT ? { take: LIMIT } : {}),
    });

    // Count (but never process) the historical placeholder vehicles excluded above.
    const excludedPlaceholders = await prisma.vehicle.count({
      where: {
        serviceClass: null,
        vehicleCode: { startsWith: PLACEHOLDER_VEHICLE_CODE_PREFIX },
      },
    });

    const plan = planClassificationBackfill(
      vehicles.map((v) => ({
        id: v.id,
        make: v.make,
        model: v.model,
        modelYear: v.modelYear,
        classificationStatus: v.classification?.status ?? null,
      })),
      rules,
    );

    let written = 0;
    if (COMMIT) {
      for (const item of plan.items) {
        if (!item.willWrite) continue; // never overwrite a CONFIRMED row
        const s = item.suggestion;
        await prisma.vehicleClassification.upsert({
          where: { vehicleId: item.vehicleId },
          create: {
            vehicleId: item.vehicleId,
            status: 'PENDING_REVIEW',
            source: 'MAKE_MODEL_LOOKUP',
            suggestedServiceClass: s.suggestedServiceClass,
            suggestedWeightClass: s.suggestedWeightClass,
            confidence: s.confidence,
          },
          update: {
            status: 'PENDING_REVIEW',
            source: 'MAKE_MODEL_LOOKUP',
            suggestedServiceClass: s.suggestedServiceClass,
            suggestedWeightClass: s.suggestedWeightClass,
            confidence: s.confidence,
          },
        });
        written++;
      }
    }

    // Suggested serviceClass breakdown (advisory only).
    const byClass: Record<string, number> = {};
    for (const item of plan.items) {
      const k = item.suggestion.suggestedServiceClass ?? '(none)';
      byClass[k] = (byClass[k] ?? 0) + 1;
    }

    // Sample redacted rows: make/model/year + advisory suggestion only.
    // No plate, VIN, vehicleCode, customer, or any PII.
    const vehById = new Map(vehicles.map((v) => [v.id, v]));
    const sample = plan.items.slice(0, 8).map((i) => {
      const v = vehById.get(i.vehicleId)!;
      return {
        make: v.make ?? '(unknown)',
        model: v.model ?? '(unknown)',
        year: v.modelYear ?? '(unknown)',
        suggestedServiceClass: i.suggestion.suggestedServiceClass ?? '(none)',
        confidence: i.suggestion.confidence,
        willCreatePending: i.willWrite,
      };
    });

    console.warn('--- Vehicle classification backfill ---');
    console.warn(`mode:                 ${COMMIT ? 'COMMIT' : 'DRY-RUN (no writes)'}`);
    console.warn(`eligible considered:  ${vehicles.length} (live, unclassified)`);
    console.warn(`excluded placeholders:${excludedPlaceholders} (HIST-UNRESOLVED-*, never processed)`);
    console.warn('suggestion confidence:');
    console.warn(`  HIGH:               ${plan.counts.HIGH}`);
    console.warn(`  MEDIUM:             ${plan.counts.MEDIUM}`);
    console.warn(`  LOW:                ${plan.counts.LOW}`);
    console.warn(`  NONE:               ${plan.counts.NONE}`);
    console.warn('suggested serviceClass breakdown:');
    for (const [k, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
      console.warn(`  ${k.padEnd(24)} ${n}`);
    }
    console.warn(`already had a row:    ${plan.alreadyHasRow} (confirmed, preserved: ${plan.alreadyConfirmed})`);
    console.warn(`PENDING would create: ${plan.toWriteCount}`);
    console.warn(`rows written:         ${COMMIT ? written : 0}`);
    console.warn('sample (redacted, no PII):');
    for (const s of sample) {
      console.warn(
        `  ${String(s.make).padEnd(12)} ${String(s.model).padEnd(16)} ${String(s.year).padEnd(8)} -> ${String(s.suggestedServiceClass).padEnd(22)} [${s.confidence}]${s.willCreatePending ? '' : ' (preserve)'}`,
      );
    }
    console.warn('NOTE: Vehicle.serviceClass is NEVER written by this script.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
