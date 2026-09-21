import { describe, it, expect } from 'vitest';
import {
  InvalidCustomerEmailError,
  isPlaceholderEmail,
  isValidCustomerEmail,
  normalizeCustomerEmail,
  normalizeImportedEmail,
} from '../customer-email';

/**
 * CR-2026-113 §2 — placeholder text must not behave like an email address.
 *
 * The import put the literal "N/A" in 3,649 customers' email column, which made
 * "we can reach this customer" read as true everywhere that checks presence.
 * These checks keep it from happening again at every write boundary.
 */

describe('placeholders are "no address", not an error', () => {
  it('recognises the values people actually type', () => {
    for (const v of ['N/A', 'n/a', ' N/A ', 'na', 'NA', 'n.a.', 'none', 'NULL', 'nil', '-', '--', '.', 'no email', 'unknown', '']) {
      expect(isPlaceholderEmail(v), v).toBe(true);
      expect(normalizeCustomerEmail(v), v).toBeNull();
    }
  });

  it('never mistakes a real address for a placeholder', () => {
    for (const v of ['na@example.com', 'none@berts.example', 'x@y.co']) {
      expect(isPlaceholderEmail(v), v).toBe(false);
      expect(normalizeCustomerEmail(v), v).toBe(v.toLowerCase());
    }
  });
});

describe('normalisation', () => {
  it('trims and lower-cases, so one customer is not two records', () => {
    expect(normalizeCustomerEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
  });

  it('leaves undefined alone — a partial update must not blank an address it was not given', () => {
    expect(normalizeCustomerEmail(undefined)).toBeUndefined();
  });

  it('an explicit null clears the address', () => {
    expect(normalizeCustomerEmail(null)).toBeNull();
  });

  it('rejects text that is neither blank nor an address, and says what to do', () => {
    expect(() => normalizeCustomerEmail('driver Jason West')).toThrow(InvalidCustomerEmailError);
    try {
      normalizeCustomerEmail('sashan.wisdom99gmail.com');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/not a valid email address/);
      expect((e as Error).message).toMatch(/name@example\.com/);
    }
  });

  it('rejects an absurdly long value', () => {
    expect(() => normalizeCustomerEmail(`${'a'.repeat(250)}@example.com`)).toThrow();
  });
});

describe('the bulk import path', () => {
  it('reports a bad address instead of aborting the run, and stores nothing', () => {
    // A 9,000-row import must not stop dead on one malformed cell — the row is
    // named in the coverage report and a person decides what it should be.
    expect(normalizeImportedEmail('sashan.wisdom99gmail.com')).toEqual({
      value: null,
      rejected: 'sashan.wisdom99gmail.com',
    });
  });

  it('turns placeholders into nothing, silently — they carry no information', () => {
    expect(normalizeImportedEmail('N/A')).toEqual({ value: null, rejected: null });
  });

  it('passes a real address through, normalised', () => {
    expect(normalizeImportedEmail(' Jane@Example.com ')).toEqual({ value: 'jane@example.com', rejected: null });
  });
});

describe('validity', () => {
  it('agrees with the notification engine about what can be sent to', () => {
    expect(isValidCustomerEmail('customer@example.com')).toBe(true);
    expect(isValidCustomerEmail('N/A')).toBe(false);
    expect(isValidCustomerEmail('')).toBe(false);
    expect(isValidCustomerEmail(null)).toBe(false);
    expect(isValidCustomerEmail('bad@@example')).toBe(false);
  });
});
