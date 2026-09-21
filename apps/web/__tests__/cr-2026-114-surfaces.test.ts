import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-114 §5–§8 — the booking asymmetry, honest preference semantics, and
 * WhatsApp as a hand-off rather than a channel.
 */
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const readVisible = (p: string) =>
  read(p)
    .replace(BLOCK_COMMENT, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

describe('CR-2026-114 §5 — online booking needs an email; staff booking does not', () => {
  it('the public page asks for it in plain language', () => {
    const src = read('app/book/page.tsx');
    expect(src).toContain('Enter your email address to receive your booking confirmation and appointment updates.');
    expect(src).toMatch(/disabled=\{busy \|\| !slot \|\| \(isNew && !email\.includes\('@'\)\)\}/);
  });

  it('the staff wizard does not require one, and says what will not be sent', () => {
    const src = read('app/(dashboard)/appointments/new/page.tsx');
    expect(src).toContain('no-email-booking');
    expect(src).toContain('No email on file — no confirmation or reminder will be sent');
    // Nothing in the staff path blocks Confirm on an address.
    expect(src).not.toMatch(/disabled=\{[^}]*email[^}]*\}/);
  });
});

describe('CR-2026-114 §6/§7 — unknown is never dressed up as declined', () => {
  const src = read('app/(dashboard)/customers/[id]/page.tsx');

  it('the profile shows the two things separately, in plain words', () => {
    expect(src).toContain('email-communications');
    expect(src).toContain('Email communications');
    expect(src).toContain('Service & appointment updates');
    expect(src).toContain('Optional outreach');
    expect(src).toContain('marketing-preference');
  });

  it('offers all three states when a person records one', () => {
    for (const option of ['Allowed — they agreed', 'Declined — they asked not to', 'Not recorded — nobody has asked yet']) {
      expect(src, option).toContain(option);
    }
  });

  it('never shows database terminology to staff', () => {
    const visible = readVisible('app/(dashboard)/customers/[id]/page.tsx');
    // The field may still be READ from the API payload, but no label, option or
    // sentence a person sees may be phrased in terms of the column.
    expect(visible).not.toMatch(/>[^<]*notificationOptInEmail[^<]*</);
    expect(visible).not.toMatch(/Opted (in|out)/);
  });

  it('describes "unknown" as an unanswered question, not a refusal', () => {
    expect(src).toMatch(/Nobody has asked this customer yet|Preference unknown/);
    expect(src).not.toMatch(/customer (has )?refused|opted out of everything/i);
  });

  it('says plainly that operational email is not governed by the preference', () => {
    expect(src).toMatch(/Booking confirmations, authorisation requests and[\s\S]*always sent/);
  });
});

describe('CR-2026-114 §wording — no channel-hopping around a preference', () => {
  const src = read('components/notification-composer.tsx');

  it('tells an advisor a Manager authorises the exception', () => {
    expect(src).toContain('consent-needs-manager');
    expect(src).toMatch(/A Manager is required to authorize an exception/);
    expect(src).toMatch(/approved\s*\n?\s*customer-contact method in accordance with/);
  });

  it('no longer suggests phoning the customer as the way round it', () => {
    expect(src).not.toMatch(/call the customer and log the call/i);
    expect(src).not.toMatch(/You can also call/i);
  });

  it('shows WHICH state is blocking, so the two are distinguishable on screen', () => {
    expect(src).toContain('consent-state');
    expect(src).toContain('Recorded preference:');
    expect(src).toContain('preferenceLabel');
  });
});

describe('CR-2026-114 §8 — WhatsApp is a hand-off, never a channel', () => {
  it('appears only in the booking-link sharing component', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.next') continue;
          walk(rel);
        } else if (/\.tsx?$/.test(entry.name)) {
          if (rel.includes('send-booking-link') || rel.includes('__tests__')) continue;
          if (/whatsapp/i.test(read(rel))) offenders.push(rel);
        }
      }
    };
    walk('app');
    walk('components');
    expect(offenders, 'WhatsApp appears outside the booking-link hand-off').toEqual([]);
  });

  it('is a link the staff member opens, with no provider configuration', () => {
    const src = read('components/send-booking-link.tsx');
    expect(src).toContain('whatsappUrl');
    expect(src).toMatch(/target="_blank"/);
    expect(src).toMatch(/the system does not send it/i);
    // No API key, no provider selection, no send call.
    expect(src).not.toMatch(/api\.post|provider|accessToken|apiKey/i);
  });

  it('records no delivery: the component never posts a notification', () => {
    const src = read('components/send-booking-link.tsx');
    expect(src).not.toMatch(/notifications\/send|notificationLog|displayState/);
  });

  it('keeps copy-message, and still does not bring SMS back', () => {
    // Comments may explain what was removed and why; only live code and the
    // words a person reads are held to this.
    const src = readVisible('components/send-booking-link.tsx');
    expect(src).toContain('Copy message');
    expect(src).not.toContain('smsUrl');
    expect(src).not.toMatch(/\bSMS\b/);
  });
});
