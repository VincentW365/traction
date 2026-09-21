import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-113 — consent belongs to optional outreach; operational email is the
 * service.
 *
 * The regression these guard against is subtle and expensive: a screen that
 * asks the front desk to "override" a customer's preference in order to send an
 * appointment confirmation. Do that on the routine path and the override stops
 * being exceptional, the preference stops meaning anything, and the audit trail
 * fills with entries nobody reads.
 */
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('CR-2026-113 §1 — the composer knows what a message is FOR', () => {
  const src = read('components/notification-composer.tsx');

  it('shows the purpose, and asks the server rather than deciding for itself', () => {
    expect(src).toContain('message-purpose');
    expect(src).toContain('PURPOSE_LABELS');
    for (const p of ['TRANSACTIONAL', 'REMINDER', 'MARKETING']) expect(src, p).toContain(p);
    // The block is driven by the server's decision, not by re-deriving it here.
    expect(src).toContain('!data.consent.allowed');
  });

  it('never blocks on the preference for a message the server allowed', () => {
    // The old unconditional opt-out tickbox is gone: it keyed off the customer's
    // flag alone, which is exactly the behaviour this CR removes.
    expect(src).not.toContain('emailOptedOut');
    expect(src).not.toMatch(/customer opted out of email messages\. I confirm this operational message/i);
  });

  it('an override needs a reason, and says the reason is recorded', () => {
    expect(src).toContain('consent-block');
    expect(src).toContain('overrideReason');
    expect(src).toContain('minimumReasonLength');
    expect(src).toMatch(/recording why, against my name/i);
  });

  it('an advisor is told a manager can do it, instead of being given a dead button', () => {
    expect(src).toContain('consent-needs-manager');
    expect(src).toMatch(/canOverrideConsent = user\?\.roleCode === 'ADMIN'/);
    expect(src).toMatch(/A manager can send it anyway/i);
  });
});

describe('CR-2026-113 §1 — the preference is labelled for what it now governs', () => {
  it('the customer profile says it covers optional email, and what is always sent', () => {
    const src = read('app/(dashboard)/customers/[id]/page.tsx');
    expect(src).toContain('Service reminders &amp; offers');
    expect(src).toMatch(/Booking confirmations, authorisation requests and[\s\S]*always sent/);
    // The bare "Email Notifications" label is gone: it read as "we can never
    // contact this customer", which was never what the flag meant.
    expect(src).not.toContain('>Email Notifications<');
  });

  it('check-in and the appointment modal ask the optional-email question plainly', () => {
    expect(read('app/(dashboard)/check-in/page.tsx')).toContain('service reminders and offers by email');
    expect(read('components/appointment-detail-modal.tsx')).toContain('service reminders and offers by email');
  });

  it('the public booking page marks the tick as optional', () => {
    expect(read('app/book/page.tsx')).toMatch(/service reminders and offers \(optional\)/);
  });
});

describe('CR-2026-113 §3 — "Collection", everywhere a person reads it', () => {
  const surfaces: Array<[string, string]> = [
    ['components/communication-history.tsx', "PICKUP_READY: 'Ready for Collection'"],
    ['app/(dashboard)/queue/page.tsx', 'label="Ready for Collection"'],
    ['app/(dashboard)/reports/page.tsx', "'Ready for Collection'"],
    ['app/display/[token]/page.tsx', 'Ready for collection'],
    ['components/schedule/queue-rail.tsx', 'Ready for Collection'],
    ['components/notification-composer.tsx', 'Vehicle Ready for Collection'],
    ['components/pickup-notification-panel.tsx', 'Ready for Collection'],
  ];

  it.each(surfaces)('%s says Collection', (file, expected) => {
    expect(read(file)).toContain(expected);
  });

  it('no customer-facing screen still says "pickup"', () => {
    for (const [file] of surfaces) {
      const visible = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      // Internal identifiers (readyForPickup, PICKUP_READY, /queue/pickup) are
      // deliberately untouched: renaming stored values to change a label would
      // rewrite history. Only the words a person reads are checked here.
      const prose = visible.match(/>[^<>{}]*pickup[^<>{}]*</gi) ?? [];
      expect(prose, `${file} still shows "pickup" to a person`).toEqual([]);
    }
  });
});

describe('CR-2026-113 §4 — WhatsApp is a hand-off, not a channel', () => {
  const src = read('components/send-booking-link.tsx');

  it('offers the WhatsApp share again', () => {
    expect(src).toContain('whatsappUrl');
    expect(src).toContain('WhatsApp');
  });

  it('says plainly that the platform sends nothing', () => {
    expect(src).toMatch(/opens on your device — the system does not send it/i);
  });

  it('does not bring SMS back with it', () => {
    expect(src).not.toContain('smsUrl');
    expect(src).not.toMatch(/Text message/i);
  });
});
