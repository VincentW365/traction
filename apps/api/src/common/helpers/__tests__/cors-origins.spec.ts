import { describe, it, expect } from 'vitest';
import {
  assessCorsOrigins,
  InvalidCorsConfigurationError,
  parseCorsOrigins,
  resolveCorsOrigins,
} from '../cors-origins';

/**
 * CR-2026-110 §5 — no wildcard credentialed CORS.
 *
 * The failure this prevents is not theoretical: when a public page cannot reach
 * the API, `API_CORS_ORIGIN=*` is the first thing anyone tries. It does not even
 * work (browsers refuse a wildcard with credentials), and the natural next move
 * — reflecting whatever Origin arrives — would let any site a signed-in staff
 * member visits call this API as them.
 */

describe('wildcards are refused outright', () => {
  it.each(['*', 'null', 'true', 'ALL', 'any'])('refuses %s', (value) => {
    const a = assessCorsOrigins(value, true);
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/wildcard|credentials/i);
  });

  it('refuses a wildcard hidden in a list of good origins', () => {
    expect(assessCorsOrigins('https://web.example.com, *', true).ok).toBe(false);
  });

  it('throws at boot rather than serving an unsafe policy', () => {
    expect(() => resolveCorsOrigins('*', true)).toThrow(InvalidCorsConfigurationError);
    // The message has to tell whoever set it what to do instead.
    expect(() => resolveCorsOrigins('*', true)).toThrow(/List the exact web origin/i);
  });
});

describe('what a real deployment needs', () => {
  it('accepts one https origin', () => {
    expect(resolveCorsOrigins('https://service.bertsautoparts.com', true)).toBe('https://service.bertsautoparts.com');
  });

  it('accepts several, and hands them over as a list', () => {
    expect(resolveCorsOrigins('https://a.example.com, https://b.example.com', true)).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('trims a trailing slash, which browsers never send', () => {
    expect(parseCorsOrigins('https://a.example.com/')).toEqual(['https://a.example.com']);
  });

  it('requires https in production', () => {
    expect(assessCorsOrigins('http://web.example.com', true).ok).toBe(false);
    expect(assessCorsOrigins('http://web.example.com', true).reason).toMatch(/https/);
  });

  it('leaves local development alone', () => {
    expect(assessCorsOrigins('http://localhost:3000', false).ok).toBe(true);
  });

  it('rejects an entry that is a URL rather than an origin', () => {
    expect(assessCorsOrigins('https://web.example.com/app', true).ok).toBe(false);
    expect(assessCorsOrigins('web.example.com', true).ok).toBe(false);
  });

  it('refuses to start with nothing configured — that is not "allow everything"', () => {
    const a = assessCorsOrigins('', true);
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/not set/i);
  });
});
