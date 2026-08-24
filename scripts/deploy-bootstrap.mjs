/**
 * CR-2026-094 — production bootstrap. NON-DESTRUCTIVE by construction.
 *
 *   pnpm deploy:bootstrap
 *
 * Prepares a deployed environment in one command: validates the environment,
 * applies pending migrations (prisma migrate deploy — additive, never reset),
 * runs the idempotent reference seed, and reports whether operational data exists.
 *
 * What it deliberately does NOT do:
 *   - import customers: real customer data moves only through the controlled
 *     import (pnpm customers:import), reviewed as a dry-run first;
 *   - reset, drop, or force anything: there is no code path here that deletes.
 *
 * Exit code is the truth: 0 only when every step succeeded.
 */
import { execSync } from 'node:child_process';

const run = (label, cmd) => {
  console.log(`\n=== ${label} ===`);
  execSync(cmd, { stdio: 'inherit' });
};

console.log('BSOP deployment bootstrap (non-destructive)');

// 1. Environment. Presence only; a missing variable is named, never echoed.
const missing = ['DATABASE_URL', 'JWT_SECRET'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\nFAIL — missing required environment variables: ${missing.join(', ')}`);
  console.error('Set them in the environment (never in a committed file) and rerun.');
  process.exit(1);
}
if ((process.env.JWT_SECRET ?? '').length < 32) {
  console.error('\nFAIL — JWT_SECRET must be at least 32 characters.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_LOGIN === 'true') {
  console.error('\nFAIL — ALLOW_DEV_LOGIN must be "false" in production.');
  process.exit(1);
}
console.log('\n=== Environment ===\nRequired variables present.');

try {
  // 2. Schema. migrate deploy applies pending migrations and touches nothing else —
  //    it cannot drop data and it no-ops when current.
  run('Migrations (prisma migrate deploy)', 'pnpm exec prisma migrate deploy');

  // 3. Reference data. The seed is idempotent and create-if-missing: it never
  //    overwrites operator-edited configuration and never touches operational rows.
  run('Reference data (pnpm db:seed)', 'pnpm run db:seed');

  // 4. Readiness. The same read-only preflight the operator can run on its own;
  //    an empty customer table is a warning here, not a failure.
  run('Preflight (pnpm deploy:check)', 'node scripts/deploy-check.mjs');
} catch {
  console.error('\nFAIL — bootstrap stopped at the step above. Nothing destructive was attempted.');
  process.exit(1);
}

console.log('Bootstrap complete. If the preflight warned that the customer database is');
console.log('empty, run the approved customer import next — see docs/DEPLOYMENT_HANDOFF.md.');
