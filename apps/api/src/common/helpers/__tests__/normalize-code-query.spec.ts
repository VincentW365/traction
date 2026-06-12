import { describe, it, expect } from 'vitest';
import { normalizeCodeQuery } from '../normalize-code-query';

describe('normalizeCodeQuery (CR-2026-027)', () => {
  it('strips separators and uppercases so all code shapes collapse to one', () => {
    expect(normalizeCodeQuery('SC1211KC')).toBe('SC1211KC');
    expect(normalizeCodeQuery('SC-1211KC')).toBe('SC1211KC');
    expect(normalizeCodeQuery('sc 1211 kc')).toBe('SC1211KC');
    expect(normalizeCodeQuery('  SC-1211-KC ')).toBe('SC1211KC');
    expect(normalizeCodeQuery('1211kc')).toBe('1211KC');
  });

  it('is safe for empty / separator-only / nullish input', () => {
    expect(normalizeCodeQuery('')).toBe('');
    expect(normalizeCodeQuery('---')).toBe('');
    expect(normalizeCodeQuery(undefined as unknown as string)).toBe('');
  });
});
