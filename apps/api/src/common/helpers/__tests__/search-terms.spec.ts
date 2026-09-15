import { describe, it, expect } from 'vitest';
import { parseSearchQuery, phoneForStorage, plateForStorage, normalizePhone, normalizePlate } from '../search-terms';

/** CR-2026-106 — the one search parser (docs/121 §C1). */

describe('parseSearchQuery', () => {
  it('trims, collapses spaces and tokenises', () => {
    const p = parseSearchQuery('  vincent   wilson ');
    expect(p.raw).toBe('vincent wilson');
    expect(p.tokens).toEqual(['vincent', 'wilson']);
    expect(p.nameTokens).toEqual(['vincent', 'wilson']);
    expect(p.looksLikePhone).toBe(false);
  });

  it('recognises phone numbers in every common format and keeps the last 7 digits', () => {
    for (const q of ['8765551234', '876-555-1234', '(876) 555-1234', '+1 876 555 1234', '1 876 555 1234']) {
      const p = parseSearchQuery(q);
      expect(p.looksLikePhone, q).toBe(true);
      expect(p.phoneTail, q).toBe('5551234');
    }
  });

  it('does not mistake a plate or a short number for a phone', () => {
    expect(parseSearchQuery('1234AB').looksLikePhone).toBe(false);
    expect(parseSearchQuery('1234 AB').looksLikePhone).toBe(false);
    expect(parseSearchQuery('1234').looksLikePhone).toBe(false);
    expect(parseSearchQuery('555-12').looksLikePhone).toBe(false);
  });

  it('normalises plates / codes separator-insensitively and upper-case', () => {
    expect(parseSearchQuery('1234 AB').code).toBe('1234AB');
    expect(parseSearchQuery('1234-ab').code).toBe('1234AB');
    expect(parseSearchQuery('sc-1211kc').code).toBe('SC1211KC');
  });

  it('flags emails', () => {
    expect(parseSearchQuery('jane@example.test').looksLikeEmail).toBe(true);
    expect(parseSearchQuery('jane').looksLikeEmail).toBe(false);
  });

  it('is empty-safe', () => {
    const p = parseSearchQuery('   ');
    expect(p.raw).toBe('');
    expect(p.tokens).toEqual([]);
    expect(p.looksLikePhone).toBe(false);
  });
});

describe('storage normalisation', () => {
  it('phones are stored digits-only, placeholders survive', () => {
    expect(phoneForStorage('876-555-1234')).toBe('8765551234');
    expect(phoneForStorage('+1 (876) 555-1234')).toBe('18765551234');
    expect(phoneForStorage(' N/A ')).toBe('N/A');
    expect(phoneForStorage('')).toBe('');
  });

  it('plates are stored stripped and upper-cased', () => {
    expect(plateForStorage('1234 ab')).toBe('1234AB');
    expect(plateForStorage('1234-AB')).toBe('1234AB');
    expect(plateForStorage(' 1234AB ')).toBe('1234AB');
  });

  it('exposes the canonical normalisers used by the importer', () => {
    expect(normalizePhone('(876) 555-1234')).toBe('8765551234');
    expect(normalizePlate('1234 ab')).toBe('1234AB');
  });
});
