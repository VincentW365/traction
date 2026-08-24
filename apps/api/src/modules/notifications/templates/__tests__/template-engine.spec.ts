import { describe, it, expect } from 'vitest';
import {
  buildVehicleDescription,
  findDisallowedPlaceholders,
  findUnresolvedInFinal,
  isValidEmail,
  isValidMobileNumber,
  renderTemplate,
  smsSegmentInfo,
} from '../template-engine';
import { DEFAULT_TEMPLATES } from '../default-templates';

/** CR-2026-096 — safe placeholder rendering. */
describe('renderTemplate', () => {
  const SMS = DEFAULT_TEMPLATES.find((t) => t.key === 'SERVICE_DUE_SMS')!.body;

  it('renders the service-due SMS with full vehicle facts', () => {
    const { text, unresolved } = renderTemplate(SMS, {
      customerFirstName: 'Vincent',
      vehicleDescription: '2020 Honda Grace',
      registrationNumber: '1234 AB',
    });
    expect(text).toBe(
      "Hi Vincent, your 2020 Honda Grace (1234 AB) is due for servicing at Bert's Service Centre. Please contact us or book your service at your convenience. Thank you.",
    );
    expect(unresolved).toEqual([]);
  });

  it('missing vehicle year is omitted cleanly (no "null" and no double space)', () => {
    const desc = buildVehicleDescription({ modelYear: null, make: 'Honda', model: 'Grace', plateNumber: '1234 AB' });
    const { text } = renderTemplate(SMS, {
      customerFirstName: 'Vincent',
      vehicleDescription: desc,
      registrationNumber: '1234 AB',
    });
    expect(text).toContain('your Honda Grace (1234 AB)');
    expect(text).not.toMatch(/null/);
    expect(text).not.toMatch(/ {2}/);
  });

  it('missing make/model falls back to "vehicle <registration>"', () => {
    const desc = buildVehicleDescription({ modelYear: null, make: null, model: null, plateNumber: '1234 AB' });
    expect(desc).toBe('vehicle 1234 AB');
  });

  it('a placeholder with no value is removed and reported, never sent as {{...}}', () => {
    const { text, unresolved } = renderTemplate('Your {{vehicleYear}} Honda is ready.', {});
    expect(text).toBe('Your Honda is ready.');
    expect(unresolved).toEqual(['vehicleYear']);
  });

  it('empty brackets from a missing registration are tidied away', () => {
    const { text } = renderTemplate('Your car ({{registrationNumber}}) is ready.', {});
    expect(text).toBe('Your car is ready.');
  });

  it('email line breaks survive; blank-line runs collapse', () => {
    const tpl = 'Hi {{customerFirstName}},\n\n{{serviceDueDetails}}\n\nThank you';
    const { text } = renderTemplate(tpl, { customerFirstName: 'Ann' });
    expect(text).toBe('Hi Ann,\n\nThank you');
  });
});

describe('placeholder validation', () => {
  it('flags unknown placeholders (allow-list only)', () => {
    expect(findDisallowedPlaceholders('Hi {{customerFirstName}} {{evilExpr}}')).toEqual(['evilExpr']);
  });

  it('unresolved placeholders in a FINAL message are detected (send must block)', () => {
    expect(findUnresolvedInFinal('Hi {{customerFirstName}}')).toEqual(['customerFirstName']);
    expect(findUnresolvedInFinal('Hi Vincent')).toEqual([]);
  });

  it('every seeded template uses only allow-listed placeholders', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(findDisallowedPlaceholders(t.body), t.key).toEqual([]);
      if (t.subject) expect(findDisallowedPlaceholders(t.subject), t.key).toEqual([]);
    }
  });
});

describe('smsSegmentInfo', () => {
  it('one segment up to 160 GSM chars, then 153-char segments', () => {
    expect(smsSegmentInfo('a'.repeat(160)).segments).toBe(1);
    expect(smsSegmentInfo('a'.repeat(161)).segments).toBe(2);
    expect(smsSegmentInfo('a'.repeat(306)).segments).toBe(2);
    expect(smsSegmentInfo('a'.repeat(307)).segments).toBe(3);
  });

  it('non-GSM characters force UCS-2 with 70-char first segment', () => {
    const emoji = '🚗'.repeat(36); // 72 UTF-16 units
    const info = smsSegmentInfo(emoji);
    expect(info.encoding).toBe('UCS-2');
    expect(info.segments).toBeGreaterThan(1);
  });
});

describe('contact validation', () => {
  it('accepts Jamaican and NANP mobile shapes; rejects garbage', () => {
    expect(isValidMobileNumber('876-555-1234')).toBe(true);
    expect(isValidMobileNumber('+18765551234')).toBe(true);
    expect(isValidMobileNumber('555-1234')).toBe(true); // 7-digit local → +1876
    expect(isValidMobileNumber('12345')).toBe(false);
    expect(isValidMobileNumber('')).toBe(false);
    expect(isValidMobileNumber('not a phone')).toBe(false);
  });

  it('validates email shape server-side', () => {
    expect(isValidEmail('customer@example.com')).toBe(true);
    expect(isValidEmail('bad@@example')).toBe(false);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
