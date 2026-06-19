/**
 * CR-2026-053 — remove dev-login sandbox sessions.
 *
 *   (default)  DRY RUN — list ACTIVE DEV_LOGIN_SESSION runs + row counts. No writes.
 *   --commit   Clean each run via the canonical sandbox cleanup engine (manifest-
 *              driven, safety-gated): deletes the session's tagged data and marks
 *              the run CLEANED_UP. Run a pg_dump backup first.
 *
 * Only touches DEV_LOGIN_SESSION runs (the safety gauntlet refuses anything else).
 * BATCH / seeded demo data and all real/imported data are never touched.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { loadCleanupPlan, evaluateSafety, executeCleanup } from '../src/modules/data-import/test-data/cleanup';

const COMMIT = process.argv.includes('--commit');
const prisma = new PrismaClient();

(async () => {
  const runs = await prisma.testDataRun.findMany({
    where: { runType: 'DEV_LOGIN_SESSION', status: 'ACTIVE' },
    select: { id: true, label: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`Dev sandbox sessions (ACTIVE DEV_LOGIN_SESSION): ${runs.length} — ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);

  const actor = await prisma.userAccount.findFirst({
    where: { roleCode: 'ADMIN', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
  if (!actor) throw new Error('No ACTIVE ADMIN found for the cleanup audit actor.');

  let cleaned = 0;
  let rows = 0;
  for (const run of runs) {
    const plan = await loadCleanupPlan(prisma, run.id);
    const safety = evaluateSafety(plan.facts, 'DEV_LOGIN_SESSION');
    if (!safety.pass) {
      console.log(`  SKIP ${run.label}: safety failed (${safety.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')})`);
      continue;
    }
    console.log(`  ${COMMIT ? 'clean' : 'would clean'} ${run.label} — ${plan.totalRows} row(s)`);
    if (COMMIT) {
      await executeCleanup(prisma, {
        runId: run.id,
        backup: 'cleanup-dev-sessions script (CR-2026-053; pg_dump taken beforehand)',
        actorUserId: actor.id,
        auditAction: 'DEV_SANDBOX_CLEANED_UP',
        auditReasonCode: 'DEV_SANDBOX_CLEANUP',
      });
      cleaned++;
      rows += plan.totalRows;
    }
  }
  console.log(COMMIT ? `Removed ${cleaned} session(s), ${rows} row(s).` : 'Dry run — re-run with --commit to apply.');
})().catch((e) => { console.error(`ERROR: ${e?.message ?? e}`); process.exit(1); }).finally(() => prisma.$disconnect());
