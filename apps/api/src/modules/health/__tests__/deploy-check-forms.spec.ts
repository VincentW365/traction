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
