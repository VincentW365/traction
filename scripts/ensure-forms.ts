/**
 * CR-2026-107 — heal a deployed database that is missing required inspection forms.
 *
 *     pnpm forms:ensure
 *
 * For the case the CR calls out: a deployment already in the manager's hands where
 * the Job Sheet works but Vehicle Inspection and/or Pre-Inspection are missing. It
 * adds only what is absent and nothing else.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION. There is no delete of a template, an inspection,
 * a visit, a customer or a photograph anywhere in this path. It creates a missing
 * template, reactivates a deactivated one, restores a checklist that lost its items,
 * and stands down an itemless newer version that would shadow a good one. Completed
 * inspections keep the exact template version they were performed against.
 *
 * Safe to run against a live database and safe to run twice — a healthy deployment
 * reports "already correct" and writes nothing.
 *
 * Run it against a remote deployment by exporting that environment's connection
 * string first (Render: the EXTERNAL database URL), e.g.
 *     DATABASE_URL="postgresql://..." pnpm forms:ensure
 *
 * Exit code is the truth: 0 only when all three required forms are usable.
 *
 * It imports the canonical definition straight from the API source, so it can never
 * repair a database to a different shape than the running application expects.
 */
import { PrismaClient } from '@prisma/client';
import { ensureRequiredForms } from '../apps/api/src/modules/inspections/templates/required-forms';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('FAIL — DATABASE_URL is not set. Point it at the environment you want to repair.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  console.log('BSOP required-forms bootstrap (non-destructive)\n');

  try {
    const { actions, changed, state } = await ensureRequiredForms(prisma);

    if (!changed) {
      console.log('Already correct — no changes were needed.');
    } else {
      console.log(`Repaired ${actions.length} item(s):`);
      for (const a of actions) console.log(`  ${a.form}: ${a.action} — ${a.detail}`);
    }

    const mark = (ok: boolean): string => (ok ? 'PASS' : 'FAIL');
    console.log('\nRequired Operational Forms');
    console.log(`  Job Sheet:            ${mark(state.jobSheet)}`);
    console.log(`  Pre-Job Inspection:   ${mark(state.preJobInspection)}`);
    console.log(`  Vehicle Inspection:   ${mark(state.serviceInspection)}`);

    if (!(state.jobSheet && state.preJobInspection && state.serviceInspection)) {
      console.error('\nFAIL — a required form is still unusable.');
      if (!state.jobSheet) console.error('  Job Sheet needs its table: run pnpm db:migrate.');
      process.exitCode = 1;
      return;
    }
    console.log('\nOK — every required operational form can be opened.');
  } catch (e: unknown) {
    console.error(`\nFAIL — ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
