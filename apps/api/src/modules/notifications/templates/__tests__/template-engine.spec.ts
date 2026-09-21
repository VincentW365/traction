import { describe, it, expect } from 'vitest';
import {
  buildVehicleDescription,
  findDisallowedPlaceholders,
  findUnresolvedInFinal,
  isValidEmail,
  renderTemplate,
} from '../template-engine';
import { DEFAULT_TEMPLATES } from '../default-templates';

/**
 * CR-2026-096 — safe placeholder rendering.
 * CR-2026-112 — email only: the SMS segment maths and the mobile-number
 * validator went with the SMS provider, and a labelled line whose value is
 * missing is now dropped whole.
 */
describe('renderTemplate', () => {
  const SERVICE_DUE = DEFAULT_TEMPLATES.find((t) => t.key === 'SERVICE_DUE_EMAIL')!.body;

  it('renders the service-due email with full vehicle facts', () => {
    const { text, unresolved } = renderTemplate(SERVICE_DUE, {
      customerFirstName: 'Vincent',
      vehicleDescription: '2020 Honda Grace',
      registrationNumber: '1234 AB',
      serviceDueDetails: 'Recommended service: Oil Change\nDue date: June 1, 2026',
    });
    expect(text).toContain('Hi Vincent,');
    expect(text).toContain('your 2020 Honda Grace, registration 1234 AB, is due for servicing');
    expect(text).toContain('Recommended service: Oil Change');
    expect(unresolved).toEqual([]);
  });

  it('missing vehicle year is omitted cleanly (no "null" and no double space)', () => {
    const desc = buildVehicleDescription({ modelYear: null, make: 'Honda', model: 'Grace', plateNumber: '1234 AB' });
    const { text } = renderTemplate(SERVICE_DUE, {
      customerFirstName: 'Vincent',
      vehicleDescription: desc,
      registrationNumber: '1234 AB',
    });
    expect(text).toContain('your Honda Grace, registration 1234 AB');
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

  /** CR-2026-112 — the appointment emails are written as labelled lines. */
  it('a labelled line whose only value is missing is dropped whole, never sent as "Vehicle:"', () => {
    const tpl = 'Reference: {{appointmentReference}}\nWhen: {{appointmentWhen}}\nVehicle: {{vehicleDescription}}';
    const { text } = renderTemplate(tpl, { appointmentReference: 'BK-4821', appointmentWhen: 'Fri, Sep 25, 9:00 AM' });
    expect(text).toBe('Reference: BK-4821\nWhen: Fri, Sep 25, 9:00 AM');
    expect(text).not.toContain('Vehicle:');
  });

  it('a placeholder inside a sentence still just disappears (the line is kept)', () => {
    const { text } = renderTemplate('We will call you on {{actionNeededBy}} about the quote.', {});
    expect(text).toBe('We will call you on about the quote.');
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

  /** CR-2026-112 §1 — the seeded set is an EMAIL set, one template per reason. */
  it('every seeded template is an email with a subject, and each reason appears once', () => {
    const reasons = new Set<string>();
    for (const t of DEFAULT_TEMPLATES) {
      expect(t.channel, t.key).toBe('EMAIL');
      expect(t.subject.trim().length, t.key).toBeGreaterThan(0);
      expect(reasons.has(t.reason), `${t.reason} seeded twice`).toBe(false);
      reasons.add(t.reason);
    }
    for (const required of [
      'SERVICE_DUE',
      'CUSTOMER_ACTION_REQUIRED',
      'PICKUP_READY',
      'APPOINTMENT_CONFIRMATION',
      'APPOINTMENT_CHANGED',
      'APPOINTMENT_CANCELLED',
      'APPOINTMENT_REMINDER',
    ]) {
      expect(reasons.has(required), `${required} has no seeded template`).toBe(true);
    }
  });
});

describe('contact validation', () => {
  it('validates email shape server-side', () => {
    expect(isValidEmail('customer@example.com')).toBe(true);
    expect(isValidEmail('bad@@example')).toBe(false);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
