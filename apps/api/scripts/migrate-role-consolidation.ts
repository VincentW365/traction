/**
 * CR-2026-048 — one-off data migration for the role consolidation.
 *
 *   (default)  DRY-RUN — print the plan + current/target role counts. No writes.
 *   --commit   Apply: reassign MANAGER→ADMIN, FRONT_DESK→SERVICE_ADVISOR, and
 *              DELETE the Parts Staff / Transport Coordinator accounts.
 *
 * Deletions: the affected accounts are seed/DEVTEST users. To avoid breaking
 * foreign keys (and to preserve audit ROWS), every nullable UserAccount FK that
 * points at a deleted user is set to NULL first, then the user is deleted.
 * Run a DB backup first (pg_dump) — this is destructive.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const COMMIT = process.argv.slice(2).includes('--commit');
const prisma = new PrismaClient();

const REASSIGN: Array<{ from: string; to: string }> = [
  { from: 'MANAGER', to: 'ADMIN' },
  { from: 'FRONT_DESK', to: 'SERVICE_ADVISOR' },
];
const DELETE_ROLES = ['PARTS_STAFF', 'TRANSPORT_COORDINATOR'];

async function roleCounts() {
  const rows = await prisma.userAccount.groupBy({ by: ['roleCode'], _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.roleCode, r._count._all]));
}

/** Null every nullable UserAccount FK that references the given user ids (preserves rows). */
async function detachUserRefs(tx: any, ids: string[]) {
  const inIds = { in: ids };
  await tx.auditLog.updateMany({ where: { actorUserId: inIds }, data: { actorUserId: null } });
  await tx.statusHistory.updateMany({ where: { changedByUserId: inIds }, data: { changedByUserId: null } });
  await tx.appointment.updateMany({ where: { createdByUserId: inIds }, data: { createdByUserId: null } });
  await tx.businessRuleConfig.updateMany({ where: { createdByUserId: inIds }, data: { createdByUserId: null } });
  await tx.queueTicket.updateMany({ where: { overrideAppliedBy: inIds }, data: { overrideAppliedBy: null } });
  await tx.queueTicket.updateMany({ where: { overrideClearedBy: inIds }, data: { overrideClearedBy: null } });
  await tx.queueEvent.updateMany({ where: { actorUserId: inIds }, data: { actorUserId: null } });
  await tx.notificationLog.updateMany({ where: { initiatedByUserId: inIds }, data: { initiatedByUserId: null } });
  await tx.maintenanceRecommendation.updateMany({ where: { createdByUserId: inIds }, data: { createdByUserId: null } });
  await tx.vehicleClassification.updateMany({ where: { reviewedByUserId: inIds }, data: { reviewedByUserId: null } });
  await tx.transportRequest.updateMany({ where: { driverUserId: inIds }, data: { driverUserId: null } });
}

(async () => {
  console.log(`ROLE CONSOLIDATION (CR-2026-048) — ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);
  console.log('Before:', JSON.stringify(await roleCounts()));

  const toDelete = await prisma.userAccount.findMany({
    where: { roleCode: { in: DELETE_ROLES } },
    select: { id: true, email: true, roleCode: true },
  });
  console.log('Reassign:', REASSIGN.map((r) => `${r.from}→${r.to}`).join(', '));
  console.log('Delete  :', toDelete.map((u) => `${u.email} (${u.roleCode})`).join(', ') || '(none)');

  if (!COMMIT) {
    console.log('\nDry run — no writes. Re-run with --commit to apply.');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const r of REASSIGN) {
      const { count } = await tx.userAccount.updateMany({ where: { roleCode: r.from }, data: { roleCode: r.to } });
      console.log(`  reassigned ${count} ${r.from} → ${r.to}`);
    }
    const ids = toDelete.map((u) => u.id);
    if (ids.length) {
      await detachUserRefs(tx, ids);
      const { count } = await tx.userAccount.deleteMany({ where: { id: { in: ids } } });
      console.log(`  deleted ${count} parts/transport account(s)`);
    }
  });

  console.log('After:', JSON.stringify(await roleCounts()));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(`ERROR: ${e?.message ?? e}`);
  await prisma.$disconnect();
  process.exit(1);
});
