/**
 * Bulk-confirm vehicle classifications (CR-2026-008 queue clear, owner-authorized).
 *
 *   (default)            DRY-RUN — summarise what WOULD be confirmed. NO DB writes.
 *   --commit             [GATED] Confirm every PENDING_REVIEW classification:
 *                          - apply the suggested service/weight class where present,
 *                          - default to UNKNOWN_REQUIRES_REVIEW where there is none
 *                            (clears the queue but stays mobile-jack BLOCKED).
 *                        Requires --backup <path> (take a pg_dump first).
 *   --backup <path>      Backup acknowledgement (recorded in the run log).
 *   --batch <n>          Rows per transaction (default 200).
 *   --limit <n>          Cap rows processed (testing).
 *
 * Writes per row mirror ClassificationService.confirm(): Vehicle.serviceClass(+weight),
 * VehicleClassification -> CONFIRMED, AuditLog(VEHICLE_CLASSIFIED), StatusHistory.
 * Idempotent (only PENDING_REVIEW rows). Excludes placeholder + test-data vehicles.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { planConfirmation, summarizeDecisions, type PendingClassRow } from '../src/modules/vehicles/classification.bulk-apply';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const COMMIT = has('--commit');
const BACKUP = val('--backup');
const BATCH = Math.max(1, Math.min(1000, Number(val('--batch') ?? '200')));
const LIMIT = val('--limit') ? Number(val('--limit')) : undefined;

const prisma = new PrismaClient();

async function loadPending(): Promise<PendingClassRow[]> {
  const rows = await prisma.vehicleClassification.findMany({
    where: {
      status: 'PENDING_REVIEW',
      vehicle: { vehicleCode: { not: { startsWith: 'HIST-UNRESOLVED-' } }, testDataRunId: null },
    },
    select: {
      vehicleId: true,
      suggestedServiceClass: true,
      suggestedWeightClass: true,
      vehicle: { select: { serviceClass: true, weightClass: true } },
    },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  return rows.map((r) => ({
    vehicleId: r.vehicleId,
    suggestedServiceClass: r.suggestedServiceClass,
    suggestedWeightClass: r.suggestedWeightClass,
    currentServiceClass: r.vehicle.serviceClass,
    currentWeightClass: r.vehicle.weightClass,
  }));
}

function printSummary(title: string, rows: PendingClassRow[]): void {
  const s = summarizeDecisions(rows.map(planConfirmation));
  console.log(title);
  console.log(`  PENDING_REVIEW rows in scope ... ${s.total}`);
  console.log(`  apply suggested class .......... ${s.appliedSuggestion}`);
  console.log(`  default -> UNKNOWN_REQUIRES_REVIEW ${s.defaultedUnknown}  (stay mobile-jack blocked)`);
  console.log(`  newly mobile-jack eligible (SEDAN) ${s.newlyMobileJackEligible}`);
  console.log('  by target service class:');
  for (const [cls, n] of Object.entries(s.byTargetServiceClass).sort()) {
    console.log(`    ${cls.padEnd(24, '.')} ${n}`);
  }
}

async function resolveActor(): Promise<string> {
  const u =
    (await prisma.userAccount.findFirst({
      where: { status: 'ACTIVE', roleCode: { in: ['ADMIN', 'MANAGER'] } },
      orderBy: { createdAt: 'asc' },
    })) ?? (await prisma.userAccount.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } }));
  if (!u) throw new Error('No active ADMIN/MANAGER UserAccount found for the audit actor.');
  return u.id;
}

async function runCommit(rows: PendingClassRow[]): Promise<void> {
  if (!BACKUP) {
    throw new Error('Refusing: --commit requires --backup <path>. Take a pg_dump first (this mutates real vehicles + Rule 3 eligibility).');
  }
  const actorUserId = await resolveActor();
  const reviewedAt = new Date();
  let confirmed = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await prisma.$transaction(
      async (tx) => {
        for (const row of batch) {
          const d = planConfirmation(row);
          await tx.vehicle.update({
            where: { id: row.vehicleId },
            data: { serviceClass: d.serviceClass, weightClass: d.weightClass },
          });
          await tx.vehicleClassification.update({
            where: { vehicleId: row.vehicleId },
            data: {
              status: 'CONFIRMED',
              source: 'MANUAL',
              confirmedServiceClass: d.serviceClass,
              confirmedWeightClass: d.weightClass,
              reviewedByUserId: actorUserId,
              reviewedAt,
            },
          });
          await tx.auditLog.create({
            data: {
              actorUserId,
              action: 'VEHICLE_CLASSIFIED',
              entityType: 'Vehicle',
              entityId: row.vehicleId,
              beforeJson: { serviceClass: row.currentServiceClass, weightClass: row.currentWeightClass },
              afterJson: { serviceClass: d.serviceClass, weightClass: d.weightClass },
              reasonCode: 'CLASSIFICATION_CONFIRMED',
              notes: `Bulk accept-suggestion (owner-authorized queue clear); backup: ${BACKUP}`,
            },
          });
          await tx.statusHistory.create({
            data: {
              entityType: 'Vehicle',
              entityId: row.vehicleId,
              fromStatus: row.currentServiceClass ?? null,
              toStatus: d.serviceClass,
              changedByUserId: actorUserId,
              reasonCode: 'CLASSIFICATION_CONFIRMED',
            },
          });
          confirmed += 1;
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    console.log(`  …confirmed ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
  }
  console.log(`DONE — confirmed ${confirmed} classifications (actor ${actorUserId}).`);
}

async function main(): Promise<void> {
  const rows = await loadPending();
  if (!COMMIT) {
    printSummary('CONFIRM CLASSIFICATIONS — DRY RUN (no DB writes)', rows);
    console.log(`  Backup gate: --commit requires --backup <path> (take a pg_dump first).`);
    console.log('  No rows confirmed (dry run). Re-run with --commit --backup <path>.');
    return;
  }
  printSummary('CONFIRM CLASSIFICATIONS — COMMIT', rows);
  await runCommit(rows);
}

main()
  .catch((err) => {
    console.error(`ERROR: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
