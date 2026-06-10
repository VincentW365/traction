/**
 * READ-ONLY verification of the CR-2026-008 backfill. No writes.
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const total = await prisma.vehicleClassification.count();
    const pending = await prisma.vehicleClassification.count({ where: { status: 'PENDING_REVIEW' } });
    const confirmed = await prisma.vehicleClassification.count({ where: { status: 'CONFIRMED' } });

    const byConfidence = await prisma.vehicleClassification.groupBy({
      by: ['confidence'],
      _count: { _all: true },
    });
    const byClass = await prisma.vehicleClassification.groupBy({
      by: ['suggestedServiceClass'],
      _count: { _all: true },
    });

    // Safety invariant 1: NO operational Vehicle.serviceClass written.
    const vehiclesWithServiceClass = await prisma.vehicle.count({
      where: { serviceClass: { not: null } },
    });

    // Safety invariant 2: NO placeholder vehicle received a classification row.
    const placeholderClassified = await prisma.vehicleClassification.count({
      where: { vehicle: { vehicleCode: { startsWith: 'HIST-UNRESOLVED-' } } },
    });

    // Safety invariant 3: every classification row maps to a confirmed-class value? (should be 0 confirmed)
    const confirmedServiceClassSet = await prisma.vehicleClassification.count({
      where: { confirmedServiceClass: { not: null } },
    });

    console.warn('--- CR-2026-008 backfill verification (read-only) ---');
    console.warn(`vehicle_classifications total:      ${total}`);
    console.warn(`  PENDING_REVIEW:                   ${pending}`);
    console.warn(`  CONFIRMED:                        ${confirmed}`);
    console.warn('by confidence:');
    for (const r of byConfidence) console.warn(`  ${String(r.confidence).padEnd(8)} ${r._count._all}`);
    console.warn('by suggestedServiceClass:');
    for (const r of byClass.sort((a, b) => b._count._all - a._count._all)) {
      console.warn(`  ${String(r.suggestedServiceClass ?? '(none)').padEnd(24)} ${r._count._all}`);
    }
    console.warn('safety invariants:');
    console.warn(`  vehicles with operational serviceClass: ${vehiclesWithServiceClass} (expect 0)`);
    console.warn(`  placeholder vehicles classified:        ${placeholderClassified} (expect 0)`);
    console.warn(`  rows with confirmedServiceClass set:    ${confirmedServiceClassSet} (expect 0 — none confirmed)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
