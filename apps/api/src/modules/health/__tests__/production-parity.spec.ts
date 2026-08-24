import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CR-2026-094 — approved features must not be environment-gated.
 *
 * The deployed site once looked like a cut-down version of local, and the first
 * suspicion was an `if (development)` somewhere hiding modules in production. The
 * investigation found none — the difference was data, not gates — and this spec
 * keeps it that way: the modules the business approved may not read NODE_ENV at
 * all. If one ever needs to, it lands here as an explicit, argued exception.
 *
 * The two legitimate gates are listed with their reasons, and both gate DEV
 * utilities OFF in production — never a production feature off outside it.
 */

const MODULES_DIR = join(__dirname, '..', '..');

/** Modules that carry approved production functionality. */
const APPROVED_MODULES = [
  'customers',
  'vehicles',
  'appointments',
  'walk-ins',
  'queue',
  'service-orders',
  'kpi',
  'inspections',
  'technicians',
  'reporting',
  'parts',
  'complaints',
  'maintenance',
  'resources',
  'schedule',
  'status',
];

/** The whole allow-list of environment gating, with why each exists. */
const ALLOWED_GATES: Record<string, string> = {
  auth: 'dev-login is refused when NODE_ENV=production (gates a dev utility OFF, never a feature)',
  sandbox: 'test-data tooling is dev/staging only by design',
  health: 'REPORTS the environment name on the status page — reads it, gates nothing on it',
};

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts') && !entry.includes('.spec.')) out.push(full);
  }
  return out;
}

describe('production feature parity', () => {
  for (const mod of APPROVED_MODULES) {
    it(`the ${mod} module contains no NODE_ENV gating`, () => {
      const files = tsFilesUnder(join(MODULES_DIR, mod));
      expect(files.length).toBeGreaterThan(0);

      const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('NODE_ENV'));
      expect(
        offenders.map((f) => f.replace(MODULES_DIR, '')),
        `Approved functionality must behave identically in every environment. ` +
          `If this module genuinely needs an environment gate, add it to ALLOWED_GATES ` +
          `in this spec with its reason.`,
      ).toEqual([]);
    });
  }

  it('every environment gate in the codebase is on the allow-list', () => {
    const gated = readdirSync(MODULES_DIR).filter((mod) => {
      const dir = join(MODULES_DIR, mod);
      if (!statSync(dir).isDirectory()) return false;
      return tsFilesUnder(dir).some((f) => readFileSync(f, 'utf8').includes('NODE_ENV'));
    });

    for (const mod of gated) {
      expect(
        ALLOWED_GATES[mod],
        `Module "${mod}" reads NODE_ENV but is not in the allow-list. Either remove ` +
          `the gate or record the justification here.`,
      ).toBeTruthy();
    }
  });
});
