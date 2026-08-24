/**
 * CR-2026-094 — refuses to proceed when the target looks like production.
 *
 * Chained in front of the one destructive command (db:reset) so "wrong terminal,
 * right command" cannot erase the production database. Development convenience is
 * untouched: a localhost DATABASE_URL passes silently.
 */
const url = process.env.DATABASE_URL ?? '';
const isLocal = /localhost|127\.0\.0\.1/.test(url);
if (process.env.NODE_ENV === 'production' || (!isLocal && url !== '')) {
  console.error('REFUSED: this command is destructive and the DATABASE_URL is not local.');
  console.error('It must never run against a deployed database. Nothing was changed.');
  process.exit(1);
}
