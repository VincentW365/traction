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
import { execSync } from 'node:child_process';

const { PrismaClient } = prismaPkg;

const results = [];
const check = (name, ok, detail, { warnOnly = false } = {}) => {
  results.push({ name, ok, detail, warnOnly });
  const flag = ok ? 'PASS' : warnOnly ? 'WARN' : 'FAIL';
  console.log(`  [${flag}] ${name}${detail ? ` — ${detail}` : ''}`);
};

// CR-2026-106 — `--forms`: only the database connection + the Required Form
// Configuration section. Runs at every API start (render.yaml startCommand) so a
// database replaced or restored after the last build cannot serve traffic with the
// inspection forms missing while the build-time check stayed green (docs/121 §C2).
const FORMS_ONLY = process.argv.includes('--forms');

console.log(`\nBSOP deployment preflight (read-only${FORMS_ONLY ? ', required forms only' : ''})\n`);

// ---------------------------------------------------------------------------
// 1. Environment variables — presence, never values.
// ---------------------------------------------------------------------------
if (!FORMS_ONLY) {
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

// CR-2026-106 — customer-facing links (status page, booking manage link, booking
// link) are built from PUBLIC_APP_URL. In production it must be set, https, and a
// host a customer's phone can reach; otherwise every link handed to a customer
// points inside Bert's network (docs/121 §C4).
{
  const raw = (process.env.PUBLIC_APP_URL ?? '').trim();
  let ok = false;
  let detail = 'not set — customer links would fall back to the CORS origin (LAN/localhost)';
  if (raw) {
    try {
      const u = new URL(raw);
      const h = u.hostname.toLowerCase();
      const priv =
        h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' || h.endsWith('.local') || h.endsWith('.lan') ||
        /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h);
      if (u.protocol !== 'https:') detail = `${raw} — must be https:// (customers open these links on phones)`;
      else if (priv) detail = `${raw} — host is not reachable outside the local network`;
      else {
        ok = true;
        detail = raw;
      }
    } catch {
      detail = `${raw} — not a valid absolute URL`;
    }
  }
  check('PUBLIC_APP_URL', ok, detail, { warnOnly: process.env.NODE_ENV !== 'production' });
}

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_LOGIN === 'true') {
  check('ALLOW_DEV_LOGIN', false, 'is "true" in production — must be "false"');
} else {
  check('ALLOW_DEV_LOGIN', true, process.env.ALLOW_DEV_LOGIN === 'true' ? 'enabled (non-production)' : 'off');
}
} // !FORMS_ONLY

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

  if (!FORMS_ONLY) {
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

  // Deployment-parity audit (2026-09) — schema drift: does the live database
  // structurally match prisma/schema.prisma, or has manual SQL crept in? Read-only
  // (migrate diff computes, never applies). Warn-only: drift needs a human
  // decision, and a diff-engine hiccup must never block a deploy.
  try {
    // --from-schema-datasource reads DATABASE_URL through the schema's env()
    // reference — the URL never appears on a command line.
    execSync(
      'pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code',
      { stdio: 'pipe', windowsHide: true },
    );
    check('schema drift', true, 'database matches prisma/schema.prisma');
  } catch (e) {
    if (e.status === 2) {
      check('schema drift', false, 'database differs from prisma/schema.prisma — investigate before relying on this environment', { warnOnly: true });
    } else {
      check('schema drift', true, 'not checked (diff engine unavailable here)');
    }
  }

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
  // CR-2026-096 — customer notification templates. The API self-heals a missing
  // template from factory wording at compose time, so this is warn-only context,
  // but a fresh deploy should have them seeded.
  try {
    const [{ nt }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS nt FROM notification_templates`,
    );
    check('notification templates', nt >= 10, `${nt} present${nt >= 10 ? '' : ' — run pnpm db:seed (API will self-heal from factory wording)'}`);
  } catch {
    check('notification templates', false, 'table missing — run pnpm db:migrate');
  }
  await tableCheck('user accounts', 'user_accounts', 1, 'seed has not run');
  // CR-2026-097 — visit identity + relational integrity. Every visit must carry a
  // human visit number (backfilled by migration), and no inspection may disagree
  // with its visit about vehicle/customer.
  try {
    const [{ unnumbered }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS unnumbered FROM service_visits WHERE visit_number IS NULL`,
    );
    check('visit numbers', unnumbered === 0, unnumbered === 0 ? 'all visits numbered' : `${unnumbered} visit(s) missing a number — run pnpm db:migrate`);
    const [{ mismatched }] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS mismatched FROM vehicle_inspections vi
       JOIN service_visits sv ON sv.id = vi.service_visit_id
       WHERE vi.vehicle_id <> sv.vehicle_id OR vi.customer_id <> sv.customer_id`,
    );
    check('inspection↔visit integrity', mismatched === 0, mismatched === 0 ? 'consistent' : `${mismatched} inspection(s) disagree with their visit — flag for administrative review`);
  } catch {
    check('visit identity', false, 'visit_number column missing — run pnpm db:migrate');
  }

  } // !FORMS_ONLY (migrations, drift, reference data)

  // -------------------------------------------------------------------------
  // CR-2026-106 — Required form configuration. FAIL, never warn: a deployment
  // is not production-ready while an operational form cannot be opened. Each
  // check applies the EXACT predicate the API uses (inspections.service create):
  // the highest ACTIVE version per kind; the service inspection must carry
  // checklist items ON that row (an itemless newer version would shadow a good
  // one). The Job Sheet is code-defined (JobSheetDraft) and needs only its table.
  // -------------------------------------------------------------------------
  console.log('\nRequired form configuration (same predicate the API applies when a form is opened):');
  try {
    const [vi] = await prisma.$queryRawUnsafe(
      `SELECT t.version,
              (SELECT count(*)::int FROM inspection_template_items i WHERE i.template_id = t.id) AS items
       FROM inspection_templates t
       WHERE t.is_active AND t.kind = 'VEHICLE_INSPECTION'
       ORDER BY version DESC LIMIT 1`,
    );
    const [pre] = await prisma.$queryRawUnsafe(
      `SELECT t.version FROM inspection_templates t
       WHERE t.is_active AND t.kind = 'PRE_INSPECTION'
       ORDER BY version DESC LIMIT 1`,
    );
    let jobSheet = true;
    try {
      await prisma.$queryRawUnsafe('SELECT 1 FROM job_sheet_drafts LIMIT 1');
    } catch {
      jobSheet = false;
    }
    check('Job Sheet', jobSheet, jobSheet ? 'code-defined form; job_sheet_drafts present' : 'job_sheet_drafts missing — run pnpm db:migrate');
    check('Pre-Job Inspection', !!pre, pre ? `active v${pre.version}` : 'no active PRE_INSPECTION template — run pnpm db:seed');
    check(
      'Service Inspection',
      !!vi && vi.items > 0,
      vi
        ? vi.items > 0
          ? `active v${vi.version}, ${vi.items} checklist items`
          : `active v${vi.version} has NO checklist items — run pnpm db:seed`
        : 'no active VEHICLE_INSPECTION template — run pnpm db:seed',
    );
  } catch {
    check('Required forms', false, 'inspection_templates missing — run pnpm db:migrate');
  }

  if (!FORMS_ONLY) {
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
  } // !FORMS_ONLY (operational data)
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
