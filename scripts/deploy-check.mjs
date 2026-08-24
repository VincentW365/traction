/**
 * CR-2026-094 — deployment preflight. READ-ONLY.
 *
 *   pnpm deploy:check
 *
 * Answers one question with a PASS or a FAIL and actionable reasons: is this
 * environment ready to serve the application? It writes nothing, so it is safe to
 * run against production at any time, before or after a deploy.
 *
 * Secrets are checked for PRESENCE only — a missing JWT_SECRET is reported as
 * missing, never echoed.
 */
// Default-import destructure, not a named import: the generated client is CJS,
// and named-export detection has real-world failure modes (the clean-checkout
// simulation hit one at Windows' path-length limit). This form works everywhere.
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;

const results = [];
const check = (name, ok, detail, { warnOnly = false } = {}) => {
  results.push({ name, ok, detail, warnOnly });
  const flag = ok ? 'PASS' : warnOnly ? 'WARN' : 'FAIL';
  console.log(`  [${flag}] ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nBSOP deployment preflight (read-only)\n');

// ---------------------------------------------------------------------------
// 1. Environment variables — presence, never values.
// ---------------------------------------------------------------------------
console.log('Environment:');
const required = ['DATABASE_URL', 'JWT_SECRET'];
for (const name of required) {
  const v = process.env[name];
  check(name, !!v, v ? 'configured' : 'MISSING — the application will not start');
}
check(
  'JWT_SECRET length',
  (process.env.JWT_SECRET ?? '').length >= 32,
  (process.env.JWT_SECRET ?? '').length >= 32 ? 'ok' : 'must be at least 32 characters',
);

const prodOnly = ['API_CORS_ORIGIN'];
for (const name of prodOnly) {
  const v = process.env[name];
  check(name, !!v, v ? 'configured' : 'not set — required in production', {
    warnOnly: process.env.NODE_ENV !== 'production',
  });
}

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_LOGIN === 'true') {
  check('ALLOW_DEV_LOGIN', false, 'is "true" in production — must be "false"');
} else {
  check('ALLOW_DEV_LOGIN', true, process.env.ALLOW_DEV_LOGIN === 'true' ? 'enabled (non-production)' : 'off');
}

// ---------------------------------------------------------------------------
// 2. Database — connection, migrations, required tables, data presence.
// ---------------------------------------------------------------------------
console.log('\nDatabase:');
const prisma = new PrismaClient();
let dbOk = false;
try {
  await prisma.$queryRawUnsafe('SELECT 1');
  dbOk = true;
  check('connection', true, 'connected');
} catch (e) {
  check('connection', false, `cannot connect (${e.code ?? e.message?.slice(0, 60) ?? 'unknown'})`);
}

if (dbOk) {
  try {
    const [last] = await prisma.$queryRawUnsafe(
      `SELECT migration_name, finished_at FROM _prisma_migrations
       WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    );
    const [{ pending }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS pending FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
    );
    check('migrations applied', !!last, last ? `latest: ${last.migration_name}` : 'no migrations recorded');
    check('migrations pending/failed', pending === 0, pending === 0 ? 'none' : `${pending} unfinished — run pnpm db:migrate`);
  } catch {
    check('migration history', false, '_prisma_migrations missing — run pnpm db:migrate');
  }

  const count = async (table) => {
    const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${table}`);
    return n;
  };
  const tableCheck = async (label, table, min, hint, opts) => {
    try {
      const n = await count(table);
      check(label, n >= min, `${n} row(s)${n >= min ? '' : ` — ${hint}`}`, opts);
      return n;
    } catch {
      check(label, false, `table ${table} missing — run pnpm db:migrate`);
      return null;
    }
  };

  console.log('\nReference data (produced by pnpm db:seed):');
  await tableCheck('sites', 'sites', 1, 'seed has not run');
  await tableCheck('service types', 'service_types', 1, 'seed has not run');
  await tableCheck('active KPI policy', 'kpi_policies', 1, 'seed has not run');
  // Counted per KIND, not as one row total: the vehicle checklist and the photo-first
  // pre-inspection are separate templates, and "there is a template" has already
  // shipped a deploy where New Pre-Inspection failed while this check stayed green.
  try {
    const [{ vi }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS vi FROM inspection_templates WHERE is_active AND kind = 'VEHICLE_INSPECTION'`,
    );
    const [{ pre }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS pre FROM inspection_templates WHERE is_active AND kind = 'PRE_INSPECTION'`,
    );
    check('vehicle inspection template', vi >= 1, vi >= 1 ? `${vi} active` : 'missing — run pnpm db:seed');
    check('pre-inspection template', pre >= 1, pre >= 1 ? `${pre} active` : 'missing — run pnpm db:seed');
    const [{ items }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS items FROM inspection_template_items iti
       JOIN inspection_templates it ON it.id = iti.template_id
       WHERE it.is_active AND it.kind = 'VEHICLE_INSPECTION'`,
    );
    check('inspection checklist items', items >= 1, `${items} item(s)${items >= 1 ? '' : ' — seed has not run'}`);
  } catch {
    check('inspection templates', false, 'table missing — run pnpm db:migrate');
  }
  await tableCheck('user accounts', 'user_accounts', 1, 'seed has not run');

  console.log('\nOperational data (produced by the controlled customer import, never by seed):');
  const customers = await tableCheck(
    'customers', 'customers', 1,
    'empty — if this is a fresh deployment, the approved customer import has not run yet',
    { warnOnly: true },
  );
  await tableCheck('vehicles', 'vehicles', 1, 'empty — arrives with the customer import', { warnOnly: true });
  if (customers === 0) {
    console.log('         The application works with an empty customer database; the import is a');
    console.log('         separate controlled step. See docs/DEPLOYMENT_HANDOFF.md.');
  }
}

await prisma.$disconnect().catch(() => {});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const failures = results.filter((r) => !r.ok && !r.warnOnly);
const warnings = results.filter((r) => !r.ok && r.warnOnly);
console.log(
  `\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failures.length - warnings.length} ok, ${warnings.length} warning(s), ${failures.length} failure(s)\n`,
);
if (failures.length) {
  console.log('Fix before serving traffic:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  console.log('');
}
process.exit(failures.length === 0 ? 0 : 1);
