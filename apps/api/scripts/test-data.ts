/**
 * Test Data Sandbox runner (CR-2026-020, T-b).
 *
 *   test-data create [--scenarios a,b|all] [--repeat N] [--label L] [--notes "..."]
 *                        (default)  DRY-RUN — print what WOULD be created. NO DB writes.
 *                        --commit   [GATED] create a tagged TestDataRun + data + manifest.
 *                                   Requires ALLOW_TEST_DATA_TOOLS=true and --label.
 *   test-data list       List existing test runs (read-only).
 *   test-data cleanup    Placeholder — implemented in T-c (not yet available).
 *
 * Guardrails: env-gated; test customers keep CUST- numbers (name marker VWTEST);
 * obviously-fake values only; never touches imported/historical/shared infra
 * (only READS Site/ServiceType/WorkBay/Technician/UserAccount); creates nothing
 * in dry-run; cleanup/deletion is NOT in this package.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { validateEnv } from '@bsop/config';
import { assertTestDataToolsEnabled, assertValidLabel } from '../src/modules/data-import/test-data/guards';
import { resolveScenarioKeys } from '../src/modules/data-import/test-data/scenarios';
import { planRun, createRun, listRuns } from '../src/modules/data-import/test-data/runner';

const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
const has = (f: string) => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

function parseRepeat(): number {
  const r = Number(val('--repeat') ?? '1');
  if (!Number.isInteger(r) || r < 1 || r > 50) throw new Error('--repeat must be an integer 1–50.');
  return r;
}

function printUsage(): void {
  console.log(`Test Data Sandbox (CR-2026-020)

  test-data create [--scenarios a,b|all] [--repeat N] [--label L] [--notes "..."] [--commit]
      Dry-run by default (no writes). --commit creates a tagged run (needs ALLOW_TEST_DATA_TOOLS=true + --label).
      Scenarios: appointment, walkin, completed, abandon, transport  (default: appointment,walkin,completed,abandon)

  test-data list        List existing test runs (read-only).
  test-data cleanup     Not available yet — implemented in T-c.`);
}

async function runCreate(prisma: PrismaClient, env: ReturnType<typeof validateEnv>): Promise<void> {
  const scenarioKeys = resolveScenarioKeys(val('--scenarios'));
  const repeat = parseRepeat();
  const label = val('--label');
  const notes = val('--notes');
  const commit = has('--commit');

  if (!commit) {
    const plan = await planRun(prisma, {
      defaultSiteCode: env.DEFAULT_SITE_CODE,
      scenarioKeys,
      repeat,
      allowEnabled: env.ALLOW_TEST_DATA_TOOLS,
    });
    console.log('TEST DATA CREATE — DRY RUN (no DB writes)');
    console.log(`  label .............. ${label ?? '(required for --commit)'}`);
    console.log(`  ALLOW_TEST_DATA_TOOLS ${plan.allowEnabled ? 'enabled' : 'DISABLED (commit will refuse)'}`);
    console.log(`  scenarios .......... ${plan.effectiveKeys.join(', ') || '(none)'}  ×${plan.repeat}`);
    console.log('  Would create (by table):');
    for (const [table, n] of Object.entries(plan.summary.totals).sort()) {
      console.log(`    ${table.padEnd(22, '.')} ${n}`);
    }
    console.log(`    ${'TOTAL rows'.padEnd(22, '.')} ${plan.summary.totalRows}`);
    console.log(`    ${'+ manifest refs'.padEnd(22, '.')} ${plan.summary.totalRows} (one ExternalSystemRef per row)`);
    if (plan.warnings.length) {
      console.log('  Notes:');
      for (const w of plan.warnings) console.log(`    - ${w}`);
    }
    console.log('  No rows created (dry run). Re-run with --commit (and --label) to create.');
    return;
  }

  // Commit path
  assertTestDataToolsEnabled(env.ALLOW_TEST_DATA_TOOLS);
  assertValidLabel(label);
  const result = await createRun(prisma, {
    defaultSiteCode: env.DEFAULT_SITE_CODE,
    label,
    scenarioKeys,
    repeat,
    notes,
  });
  console.log('TEST DATA CREATE — COMMITTED');
  console.log(`  runId .............. ${result.runId}`);
  console.log(`  label .............. ${result.label}`);
  console.log(`  scenarios .......... ${result.executed.join(', ')}`);
  console.log('  Created (by table):');
  for (const [table, n] of Object.entries(result.counts).sort()) {
    console.log(`    ${table.padEnd(22, '.')} ${n}`);
  }
  console.log(`  manifest refs ...... ${result.manifestEntries}`);
  console.log(`  footprint matched .. ${result.footprintEntries} (extra ${result.extra})`);
  console.log(`  cleanup (T-c) ...... will target run ${result.runId}`);
}

async function runList(prisma: PrismaClient): Promise<void> {
  const runs = await listRuns(prisma);
  if (!runs.length) {
    console.log('No test runs found.');
    return;
  }
  console.log(`TEST DATA RUNS (${runs.length})`);
  for (const r of runs) {
    console.log(
      `  ${r.label}  [${r.status}]  id=${r.id}  manifest=${r.manifestCount}  created=${r.createdAt.toISOString()}`,
    );
  }
}

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const prisma = new PrismaClient();
  try {
    switch (sub) {
      case 'create':
        await runCreate(prisma, env);
        break;
      case 'list':
        await runList(prisma);
        break;
      case 'cleanup':
        console.log('cleanup is not available yet — it is implemented in T-c (CR-2026-020). No action taken.');
        break;
      default:
        printUsage();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err?.message ?? err}`);
  process.exit(1);
});
