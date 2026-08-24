import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CR-2026-095 — the platform is standalone.
 *
 * The integration module was placeholder scaffolding advertising synchronisation
 * that never existed; it is gone, and this spec keeps it gone. If a real
 * integration is ever approved, it arrives through a CR that consciously updates
 * these assertions — never by scaffolding drifting back in.
 */

const API_SRC = join(__dirname, '..', '..', '..');
const REPO = join(API_SRC, '..', '..', '..');

describe('standalone application', () => {
  it('the integrations module no longer exists', () => {
    expect(existsSync(join(API_SRC, 'modules', 'integrations'))).toBe(false);
  });

  it('the app module registers no integration module', () => {
    const appModule = readFileSync(join(API_SRC, 'app.module.ts'), 'utf8');
    expect(appModule).not.toMatch(/Integration/);
  });

  it('the integrations admin page no longer exists', () => {
    expect(
      existsSync(join(REPO, 'apps', 'web', 'app', '(dashboard)', 'admin', 'integrations')),
    ).toBe(false);
  });

  it('the sidebar offers no integration navigation', () => {
    const sidebar = readFileSync(
      join(REPO, 'apps', 'web', 'components', 'sidebar.tsx'),
      'utf8',
    );
    expect(sidebar).not.toMatch(/href: '\/admin\/integrations'/);
    expect(sidebar).not.toMatch(/label: 'Integrations'/);
  });

  it('no environment variable is required for any external business system', () => {
    // The environment contract is the complete list of what the code reads; no
    // credential in it belongs to an external business system. (Twilio/SendGrid are
    // the application's OWN notification providers, opt-in and stubbed by default.)
    const envExample = readFileSync(join(REPO, '.env.example'), 'utf8');
    expect(envExample).not.toMatch(/AUTOMATE|SAGE|SHAREPOINT/i);
  });

  it('ExternalSystemRef remains — it is the customer-import audit trail, not an integration', () => {
    const schema = readFileSync(join(REPO, 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/model ExternalSystemRef/);
  });
});
