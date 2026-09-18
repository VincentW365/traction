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

describe('CR-2026-106 §C5 — staff appointment wizard', () => {
  it('is a real multi-step wizard with Back/Change on every step, driven by the pure reducer', () => {
    const src = read('app/(dashboard)/appointments/new/page.tsx');
    expect(src).toContain("from '../../../../lib/appointment-wizard'");
    for (const s of ['Step 1: Customer', 'Step 2: Vehicle', 'Step 3: Service request', 'Step 4: Date', 'Step 5: Available time', 'Step 6: Review']) expect(src).toContain(s);
    expect(src).toContain('Change');
    expect(src).toContain('wizard-summary');
    // Slots come from the SAME engine as the customer page, not a free time input.
    expect(src).toContain('/appointments/availability?siteId=');
    expect(src).toContain('<SlotPicker');
    expect(src).not.toContain('type="time"');
    // Capacity warning stays warn-not-block (105c) and the latest-start override is explicit + recorded.
    expect(src).toContain("'CAPACITY_FULL'");
    expect(src).toContain('acknowledgeCapacity: true');
    expect(src).toContain("'AFTER_LATEST_START'");
    expect(src).toContain('overrideLatestStart: true');
    expect(src).not.toContain('window.confirm(');
  });

  it('the reducer states the reset rules explicitly', () => {
    const src = read('lib/appointment-wizard.ts');
    expect(src).toContain("case 'SELECT_CUSTOMER'");
    expect(src).toContain("case 'CUSTOMER_DETAIL_LOADED'");
    expect(src).toMatch(/vehicle: null,\s*\n\s*slot: null/);
  });

  it('deep links from the vehicle page carry both ids', () => {
    expect(read('app/(dashboard)/vehicles/[id]/page.tsx')).toContain('appointments/new?customerId=${vehicle.customer.id}&vehicleId=${vehicle.id}');
  });
});

describe('CR-2026-106 — customer booking (public page)', () => {
  it('identifies with mobile + plate OR mobile + email, never by name alone', () => {
    const src = read('app/book/page.tsx');
    expect(src).toContain("identifyBy === 'EMAIL' ? { phone: phone.trim(), email: identifyEmail.trim() } : { phone: phone.trim(), plateNumber: plate.trim() }");
    expect(src).toContain('Email on file');
    expect(src).not.toMatch(/identify',\s*\{\s*firstName/);
  });

  it('captures reason / concern / description / mileage for Job Sheet preparation and shows them on review', () => {
    const src = read('app/book/page.tsx');
    expect(src).toContain('service-request');
    for (const s of ['Reason for visit', 'Main concern', 'Anything else we should know', 'Current mileage']) expect(src).toContain(s);
    expect(src).toContain('serviceRequest:');
    expect(src).toContain('label="Your concern"');
    // Not a mechanic Job Sheet: no checklist/inspection fields on the customer page.
    expect(src).not.toContain('/inspections');
  });

  it('handles the server-enforced latest start and offers later dates from the engine (never hides slots client-side)', () => {
    const src = read('app/book/page.tsx');
    expect(src).toContain("e.code === 'AFTER_LATEST_START'");
    expect(src).toContain('Later dates');
    expect(src).toContain('&from=');
    expect(src).not.toMatch(/getHours\(\)\s*[<>]=?\s*15/);
    const picker = read('app/book/slot-picker.tsx');
    expect(picker).toContain('latestStartLabel');
    expect(picker).toContain('Appointments start no later than');
    expect(picker).toContain('min-h-11');
    expect(read('app/book/manage/[token]/page.tsx')).toContain("e.code === 'AFTER_LATEST_START'");
    expect(fs.existsSync(path.join(root, 'app/book/layout.tsx'))).toBe(true);
    expect(read('app/book/layout.tsx')).toContain('viewport');
  });

  it('staff can hand the customer the secure booking link (WhatsApp Phase 1) and review pending identities', () => {
    expect(read('components/send-booking-link.tsx')).toContain('/appointments/booking-link?siteId=');
    expect(read('components/send-booking-link.tsx')).toContain('whatsappUrl');
    expect(read('app/(dashboard)/customers/[id]/page.tsx')).toContain('<SendBookingLink');
    expect(read('app/(dashboard)/customers/page.tsx')).toContain('/customers/identity-review');
    const review = read('app/(dashboard)/customers/identity-review/page.tsx');
    expect(review).toContain("'/customers/identity-review'");
    expect(review).toContain("decision: 'MERGE_INTO_EXISTING'");
    expect(review).toContain('Nothing is merged until you decide');
    expect(read('app/(dashboard)/check-in/page.tsx')).toContain('Use reported mileage');
    // CR-2026-109 — the settings catalogue now owns which rules are editable.
    const settings = read('lib/settings-catalogue.ts');
    for (const k of ["key: 'customer_booking_latest_start'", "key: 'staff_latest_start_enforced'", "key: 'booking_share_message_template'"]) expect(settings).toContain(k);
  });
});
