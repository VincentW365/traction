import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-112 — Customer Email Notifications (docs/131).
 *
 * The acceptance criterion these checks exist for: "No active SMS buttons,
 * selectors, setup requirements or misleading SMS UI remain." A screen that
 * offers a channel this release cannot deliver on is a promise the system
 * cannot keep, so this file fails the build if one comes back.
 */
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/**
 * What a person actually sees: source with comments removed. A code comment may
 * (and does) explain what was taken out and why — that is documentation, not a
 * button. Only rendered text and live code are held to the rules below.
 */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const readVisible = (p: string) =>
  read(p)
    .replace(BLOCK_COMMENT, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

/** Every staff-facing screen that used to mention a second channel. */
const NOTIFICATION_SURFACES = [
  'components/notification-composer.tsx',
  'components/pickup-notification-panel.tsx',
  'components/communication-history.tsx',
  'components/send-booking-link.tsx',
  'components/appointment-detail-modal.tsx',
  'app/(dashboard)/admin/notifications/page.tsx',
  'app/(dashboard)/admin/deployment/page.tsx',
  'app/(dashboard)/check-in/page.tsx',
  'app/(dashboard)/customers/[id]/page.tsx',
  'app/(dashboard)/reports/due-for-contact/page.tsx',
  'app/book/page.tsx',
];

describe('CR-2026-112 §1/§11 — no SMS surface survives', () => {
  it('no notification screen renders the word SMS to a person', () => {
    for (const p of NOTIFICATION_SURFACES) {
      const src = readVisible(p);
      expect(src, `${p} still mentions SMS`).not.toMatch(/\bSMS\b/);
      expect(src, `${p} still offers to text the customer`).not.toMatch(/Text me|Text message|Text \/ Email|Text Customer/i);
    }
  });

  it('no screen sends an SMS channel to the API', () => {
    for (const p of NOTIFICATION_SURFACES) {
      const src = read(p);
      expect(src, p).not.toMatch(/channels: \[[^\]]*'SMS'/);
      expect(src, p).not.toMatch(/mutate\(\['SMS'\]\)/);
    }
  });

  it('customer consent is a single email question — no SMS opt-in remains', () => {
    for (const p of [
      'app/(dashboard)/customers/[id]/page.tsx',
      'app/(dashboard)/check-in/page.tsx',
      'components/appointment-detail-modal.tsx',
      'app/book/page.tsx',
    ]) {
      expect(readVisible(p), p).not.toMatch(/notificationOptInSms|smsOptIn|optSms/);
    }
  });
});

describe('CR-2026-112 §2/§13 — the composer is deliberately an email screen', () => {
  const src = read('components/notification-composer.tsx');

  it('is titled and actioned as email, with no channel selector', () => {
    expect(src).toContain('Email Customer');
    expect(src).toContain('Send Email');
    // The channel checkboxes are gone, not merely hidden.
    expect(src).not.toMatch(/Send via/);
    expect(src).not.toMatch(/setUseSms|useSms/);
  });

  it('posts one email payload, never a channel list', () => {
    expect(src).toContain('email: { recipient: emailTo, subject: emailSubject, body: emailBody }');
    expect(src).not.toMatch(/channels: \[/);
  });

  it('offers the three editable parts the directive requires', () => {
    for (const label of ['>To<', '>Subject<', '>Message<']) {
      expect(src.replace(/\s+/g, ' ')).toContain(label.replace(/[<>]/g, ''));
    }
    expect(src).toContain('Reset to Template');
  });
});

describe('CR-2026-112 §8 — a missing email address is stated, never worked around', () => {
  it('the composer shows the operational sentence and a way to fix it', () => {
    const src = read('components/notification-composer.tsx');
    expect(src).toContain('no-email-on-file');
    expect(src).toContain('No customer email address is recorded');
    expect(src).toContain('Save to customer record');
  });

  it('the ready-for-collection panel disables the action and says why', () => {
    const src = read('components/pickup-notification-panel.tsx');
    expect(src).toContain('NO_EMAIL_ON_FILE');
    expect(src).toContain('No email on file');
    expect(src).toMatch(/disabled=\{emailSent \|\| notifyMutation\.isPending \|\| !visit\.customerEmail\}/);
  });

  it('the wording staff read comes from one place', () => {
    const copy = readVisible('lib/notification-copy.ts');
    expect(copy).toContain('No customer email address is recorded');
    expect(copy).not.toMatch(/\bSMS\b/);
  });
});

describe('CR-2026-112 §3 — the events the directive asks for are reachable', () => {
  it('the composer offers service-due, action-required, ready-for-collection and custom', () => {
    const src = read('components/notification-composer.tsx');
    for (const reason of ['SERVICE_DUE', 'CUSTOMER_ACTION_REQUIRED', 'PICKUP_READY', 'CUSTOM']) {
      expect(src, reason).toContain(reason);
    }
    expect(src).toContain('Vehicle Ready for Collection');
    expect(src).toContain('Customer Action Required');
  });

  it('a job held for the customer offers the action-required email right there', () => {
    const src = read('app/(dashboard)/queue/[id]/page.tsx');
    expect(src).toMatch(/order\.status === 'WAITING_CUSTOMER'/);
    expect(src).toMatch(/reason: 'CUSTOMER_ACTION_REQUIRED'/);
  });

  it('Setup → Notifications lists every email template, including the appointment ones', () => {
    const src = read('app/(dashboard)/admin/notifications/page.tsx');
    for (const reason of [
      'CUSTOMER_ACTION_REQUIRED',
      'APPOINTMENT_CONFIRMATION',
      'APPOINTMENT_CHANGED',
      'APPOINTMENT_CANCELLED',
      'APPOINTMENT_REMINDER',
    ]) {
      expect(src, reason).toContain(reason);
    }
    // The channel badge is gone: every row is an email.
    expect(src).not.toContain('{t.channel}');
  });
});

describe('CR-2026-112 §10/§12 — test safety and delivery honesty are unchanged', () => {
  it('the composer still shows TEST mode and the simulated/failed states', () => {
    const src = read('components/notification-composer.tsx');
    expect(src).toContain('TEST MODE');
    expect(src).toContain('Customer will not receive this email');
    for (const s of ['SENT', 'FAILED', 'TEST_REDIRECTED', 'SIMULATED', 'CAPTURED']) {
      expect(src, s).toContain(`${s}:`);
    }
    expect(src).toMatch(/SIMULATED: 'Simulated — not delivered'/);
  });

  it('a deployment with no mailbox says so instead of implying a message was sent', () => {
    const src = read('components/notification-composer.tsx');
    expect(src).toContain('Email is not set up on this deployment');
    expect(src).toContain('not delivered');
  });
});

describe('CR-2026-112 §2 — the public booking page asks for what it needs', () => {
  const src = read('app/book/page.tsx');

  // CR-2026-114 §5 rephrased the guidance in plainer words; the requirement
  // itself is unchanged and is asserted in cr-2026-114-surfaces.
  it('requires an email and explains why', () => {
    expect(src).toContain('Enter your email address to receive your booking confirmation and appointment updates.');
    expect(src).not.toContain('Email (optional)');
  });
});
