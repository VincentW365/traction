import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-106 — go-live remediation surface checks (docs/121).
 *
 * Area 3 (notifications + links): no customer-facing link is built from the staff
 * PC's own origin; every notification screen renders the server's delivery state
 * (never "Sent" for a simulated/redirected row, never "Email Sent" on a bare 2xx);
 * Admin → Deployment can PROVE outbound email and shows whether the public base
 * URL is reachable.
 */
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('CR-2026-106 §C4 — customer links come from the public base URL', () => {
  it('no staff screen prefixes a customer link with window.location.origin', () => {
    for (const p of ['app/(dashboard)/check-in/page.tsx', 'components/appointment-detail-modal.tsx', 'app/(dashboard)/queue/[id]/page.tsx']) {
      const src = read(p);
      expect(src, p).not.toMatch(/window\.location\.origin[^\n]*customerStatus/);
      expect(src, p).not.toMatch(/window\.location\.origin\}\/status\//);
    }
    expect(read('app/(dashboard)/queue/[id]/page.tsx')).toContain('ticket.customerStatusUrl');
  });

  it('the booking confirmation prefers the API-built absolute manage URL', () => {
    const book = read('app/book/page.tsx');
    expect(book).toContain('done.manageUrl ??');
    expect(book).toContain('manageUrl?: string');
  });

  it('the production web build fails on Render without the API URL', () => {
    const cfg = read('next.config.ts');
    expect(cfg).toMatch(/process\.env\.RENDER[\s\S]*NEXT_PUBLIC_API_URL[\s\S]*throw new Error/);
  });
});

describe('CR-2026-106 §C3 — honest notification states', () => {
  it('communication history renders one labelled delivery state, never the raw enum, and never "Sent" for simulated/test rows', () => {
    const src = read('components/communication-history.tsx');
    expect(src).toContain('displayState');
    for (const s of ['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'TEST_REDIRECTED', 'SIMULATED', 'MANUAL']) expect(src).toContain(`${s}:`);
    expect(src).toMatch(/SIMULATED[\s\S]*not delivered/);
    expect(src).not.toMatch(/>\{n\.status\}</);
    expect(src).toContain("row.status === 'SENT' && row.simulated) return 'SIMULATED'");
  });

  it('the pickup panel shows the per-channel outcome from the API instead of "Sent" on any 2xx', () => {
    const src = read('components/pickup-notification-panel.tsx');
    expect(src).not.toContain("'Email Sent'");
    expect(src).not.toContain("'SMS Sent'");
    expect(src).toContain('displayState');
    expect(src).toContain('failureReason');
    expect(src).toContain('pickup-send-failure');
    expect(src).toMatch(/o === 'SENT' \|\| o === 'DELIVERED'/);
  });

  it('the composer stays open and names the reason when any channel FAILED', () => {
    const src = read('components/notification-composer.tsx');
    expect(src).toContain("=== 'FAILED'");
    expect(src).toContain('setOutcome(res.sent)');
    expect(src).toContain('send-outcome');
    expect(src).toContain('Not every channel got through');
  });

  it('Admin → Deployment can prove outbound email and shows the public URL verdict', () => {
    const page = read('app/(dashboard)/admin/deployment/page.tsx');
    expect(page).toContain('<EmailVerificationCard />');
    expect(page).toContain('Public app URL (customer links)');
    const card = read('components/email-verification-card.tsx');
    expect(card).toContain("'/notifications/verify'");
    expect(card).toContain('FAIL — outbound email is not working yet');
    expect(card).toContain('PASS — the mail server accepted the test message');
    expect(card).toContain('rejected');
  });
});
