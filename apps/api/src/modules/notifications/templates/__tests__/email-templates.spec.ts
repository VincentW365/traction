import { describe, it, expect } from 'vitest';
import { renderEmailContent } from '../email-templates';

/** CR-2026-106 — every legacy template key renders a non-empty email subject + body (docs/121 §C3). */

const KEYS = [
  'appointment_confirmation',
  'appointment_rescheduled',
  'appointment_cancelled',
  'appointment_reminder_24h',
  'appointment_reminder_2h',
  'service_delay_alert',
  'pickup_ready',
  'ready_for_pickup',
  'midday_followup',
  'maintenance_oil_change_reminder',
  'smtp_verification',
  'something_unknown',
];

describe('renderEmailContent', () => {
  it('produces a subject and a non-blank body for every key the flows use', () => {
    for (const key of KEYS) {
      const { subject, body } = renderEmailContent(key, { siteName: "Bert's", customerName: 'Vincent Wilson', scheduledStartAt: new Date('2026-09-16T14:00:00Z') });
      expect(subject.trim().length, key).toBeGreaterThan(0);
      expect(body.trim().length, key).toBeGreaterThan(20);
    }
  });

  it('pickup-ready names the vehicle and the site', () => {
    const { subject, body } = renderEmailContent('pickup_ready', { vehiclePlate: '1234AB', vehicleDescription: '2020 Honda Grace', siteName: "Bert's" });
    expect(subject).toContain('2020 Honda Grace');
    expect(body).toContain("ready for pickup at Bert's");
  });

  it('the reminder carries the date and services', () => {
    const { body } = renderEmailContent('appointment_reminder_24h', { scheduledStartAt: new Date('2026-09-16T14:00:00Z'), services: ['Oil Change', 'Brakes'] });
    expect(body).toContain('Oil Change, Brakes');
    expect(body).toMatch(/2026/);
  });

  it('booking messages reuse the SMS wording so the two channels never disagree', () => {
    const data = { siteName: "Bert's", when: 'Wed, Sep 16, 9:00 AM', reference: 'BK-B01-260916-001', manageUrl: 'https://x/book/manage/t' };
    const { body } = renderEmailContent('appointment_confirmation', data);
    expect(body).toContain('Ref BK-B01-260916-001');
    expect(body).toContain('https://x/book/manage/t');
  });
});
