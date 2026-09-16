import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-106 — the deployment preflight must FAIL (not warn) when a required
 * operational form is missing, using the same predicate the API applies, and it
 * must run that section at API start (`--forms`) so a database replaced after the
 * last build cannot serve traffic with the forms missing (docs/121 §C2).
 */
const root = path.resolve(__dirname, '../../../../../..');
const deployCheck = fs.readFileSync(path.join(root, 'scripts/deploy-check.mjs'), 'utf8');
const renderYaml = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');

describe('deploy-check — Required Form Configuration', () => {
  it('prints a per-form section with all three forms', () => {
    expect(deployCheck).toContain('Required form configuration');
    for (const form of ['Job Sheet', 'Pre-Job Inspection', 'Service Inspection']) {
      expect(deployCheck).toContain(form);
    }
  });

  it('uses the runtime predicate: top ACTIVE version per kind, items on that row for the service inspection', () => {
    expect(deployCheck).toMatch(/ORDER BY version DESC[\s\S]*LIMIT 1/);
    expect(deployCheck).toContain("kind = 'VEHICLE_INSPECTION'");
    expect(deployCheck).toContain("kind = 'PRE_INSPECTION'");
    expect(deployCheck).toContain('job_sheet_drafts');
  });

  it('supports a forms-only mode and render.yaml runs it at API start', () => {
    expect(deployCheck).toContain("'--forms'");
    expect(renderYaml).toContain('node scripts/deploy-check.mjs --forms && pnpm --filter @bsop/api start');
  });

  /**
   * CR-2026-107 — the start command must REPAIR before it VERIFIES. The forms
   * check exits non-zero on a missing form, so running it ahead of the repair
   * would stop the API before it could fix itself — turning a self-healing
   * deployment back into a dead one.
   */
  it('repairs before it verifies at API start', () => {
    // Anchor on the real directive, not the word "startCommand" in a comment.
    const line = renderYaml
      .split('\n')
      .find((l) => /^\s*startCommand:/.test(l) && l.includes('deploy-check.mjs --forms'));
    expect(line, 'the API startCommand must run the forms check').toBeTruthy();
    expect(line).toContain('forms:ensure');
    expect(line!.indexOf('forms:ensure')).toBeLessThan(line!.indexOf('deploy-check.mjs --forms'));
  });

  it('a missing form is a FAIL, never a warning', () => {
    // The forms checks must not pass { warnOnly: true }.
    const section = deployCheck.slice(deployCheck.indexOf('Required form configuration'));
    const formsBlock = section.slice(0, section.indexOf('Operational data'));
    expect(formsBlock).not.toContain('warnOnly: true');
  });
});

/**
 * CR-2026-106 — customer-facing links are built from PUBLIC_APP_URL; in production
 * the preflight must FAIL when it is unset, not https, or an internal host
 * (docs/121 §C4), and the Blueprint must declare the variable.
 */
describe('deploy-check — PUBLIC_APP_URL', () => {
  it('checks PUBLIC_APP_URL and rejects localhost / private hosts / non-https', () => {
    expect(deployCheck).toContain("check('PUBLIC_APP_URL'");
    expect(deployCheck).toMatch(/must be https/);
    expect(deployCheck).toMatch(/not reachable outside the local network/);
    expect(deployCheck).toMatch(/192\\.168\\./);
  });

  it('render.yaml declares PUBLIC_APP_URL on the API service and .env.example documents it', () => {
    expect(renderYaml).toContain('key: PUBLIC_APP_URL');
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(envExample).toContain('PUBLIC_APP_URL');
  });
});

/**
 * CR-2026-108 §7 — the global notification mode is an independent safety control
 * and must stay one. Per-record capture handles UAT now, so there is no longer
 * any reason to run production with messages globally diverted — and every reason
 * not to: a real customer would simply stop being told their car is ready, with
 * nothing on any screen looking wrong.
 */
describe('deploy-check — global notification mode', () => {
  it('fails the deployment when production is not in LIVE mode', () => {
    const block = deployCheck.slice(deployCheck.indexOf("const mode = (process.env.NOTIFICATION_MODE"));
    const section = block.slice(0, block.indexOf('} // !FORMS_ONLY'));
    // Production + non-LIVE must reach a failing check(...) call.
    expect(section).toContain("process.env.NODE_ENV === 'production'");
    expect(section).toContain("mode !== 'LIVE'");
    expect(section).toMatch(/check\(\s*'NOTIFICATION_MODE',\s*false/);
    // And it must not be softened to a warning.
    expect(section).not.toContain('warnOnly');
  });

  it('names the consequence rather than just the setting', () => {
    expect(deployCheck).toContain('every customer message would be diverted');
  });

  it('defaults to TEST when unset, so an unconfigured production deploy still fails', () => {
    expect(deployCheck).toContain("process.env.NOTIFICATION_MODE ?? 'TEST'");
  });
});
