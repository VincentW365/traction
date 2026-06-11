import { describe, it, expect } from 'vitest';
import { formatPhones, parseCustomerNotes } from '../customer-format';

describe('formatPhones (CR-2026-021)', () => {
  it('formats a clean 10-digit JM number, not flagged', () => {
    expect(formatPhones('8763341234')).toEqual({ values: ['876-334-1234'], flagged: false, raw: '8763341234' });
  });
  it('formats an 11-digit (country code) number', () => {
    expect(formatPhones('18763341234').values).toEqual(['1 876-334-1234']);
    expect(formatPhones('18763341234').flagged).toBe(false);
  });
  it('formats a 7-digit local number', () => {
    expect(formatPhones('3341234').values).toEqual(['334-1234']);
  });
  it('splits a 20-digit concatenation into two numbers (flagged)', () => {
    const r = formatPhones('87680142628763341234');
    expect(r.values).toEqual(['876-801-4262', '876-334-1234']);
    expect(r.flagged).toBe(true);
  });
  it('splits 17 digits into a 10 + 7 (flagged)', () => {
    const r = formatPhones('8768014262' + '3341234');
    expect(r.values).toEqual(['876-801-4262', '334-1234']);
    expect(r.flagged).toBe(true);
  });
  it('splits 14 digits into two locals (flagged)', () => {
    const r = formatPhones('8014262' + '3341234');
    expect(r.values).toEqual(['801-4262', '334-1234']);
    expect(r.flagged).toBe(true);
  });
  it('preserves digits and flags an ambiguous length (12)', () => {
    const r = formatPhones('123456789012');
    expect(r.values).toEqual(['123456789012']);
    expect(r.flagged).toBe(true);
  });
  it('returns no usable number for empty / short fragments (never fabricates)', () => {
    expect(formatPhones('')).toEqual({ values: [], flagged: false, raw: '' });
    expect(formatPhones(null)).toEqual({ values: [], flagged: false, raw: '' });
    expect(formatPhones('876')).toEqual({ values: [], flagged: true, raw: '876' }); // 3-digit fragment
  });
  it('strips formatting characters before parsing + preserves raw', () => {
    const r = formatPhones('(876) 334-1234');
    expect(r.values).toEqual(['876-334-1234']);
    expect(r.raw).toBe('(876) 334-1234');
  });
});

describe('parseCustomerNotes (CR-2026-021)', () => {
  it('splits the import note away from staff notes (synthetic data — no real PII)', () => {
    const note = 'import:10b5c669-06b7-4d14-937a-5aab95c2c013; raw="TEST, NAME"';
    expect(parseCustomerNotes(note)).toEqual({
      staffNotes: null,
      importMeta: { batchId: '10b5c669-06b7-4d14-937a-5aab95c2c013', rawName: 'TEST, NAME' },
    });
  });
  it('treats a real staff note as staffNotes (no import meta)', () => {
    expect(parseCustomerNotes('Prefers morning appointments')).toEqual({
      staffNotes: 'Prefers morning appointments',
      importMeta: null,
    });
  });
  it('handles null/empty notes', () => {
    expect(parseCustomerNotes(null)).toEqual({ staffNotes: null, importMeta: null });
    expect(parseCustomerNotes('')).toEqual({ staffNotes: null, importMeta: null });
  });
});
