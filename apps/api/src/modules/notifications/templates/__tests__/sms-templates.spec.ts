import { describe, it, expect } from 'vitest';
import { renderSmsBody } from '../sms-templates';

/** CR-2026-033 — SMS body rendering per templateKey (+ message/generic fallback). */
describe('renderSmsBody (CR-2026-033)', () => {
  it('renders known keys with the site + details', () => {
    expect(renderSmsBody('appointment_confirmation', { scheduledStartAt: '2026-06-20T14:00:00Z', siteName: 'Bert A' }))
      .toMatch(/confirmed/i);
    expect(renderSmsBody('ready_for_pickup', { vehiclePlate: 'ABC123', siteName: 'Bert A' }))
      .toMatch(/ready for pickup/i);
    expect(renderSmsBody('service_delay_alert', { newEstimatedCompletion: '2026-06-20T16:00:00Z' }))
      .toMatch(/longer|estimated completion/i);
  });

  it('prefers a pre-rendered message for midday_followup', () => {
    expect(renderSmsBody('midday_followup', { message: 'Custom thanks!' })).toBe('Custom thanks!');
  });

  it('falls back to message then a generic line for unknown keys', () => {
    expect(renderSmsBody('totally_unknown', { message: 'Hi there' })).toBe('Hi there');
    expect(renderSmsBody('totally_unknown', {})).toMatch(/Bert/i);
  });

  it('uses the default site name when none is provided', () => {
    expect(renderSmsBody('ready_for_pickup', { vehiclePlate: 'X' })).toMatch(/Bert's Auto Parts/i);
  });
});
