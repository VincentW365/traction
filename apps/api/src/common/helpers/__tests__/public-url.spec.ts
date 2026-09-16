import { describe, it, expect } from 'vitest';
import { assessPublicAppUrl, isPrivateOrLocalHost, publicUrl, resolvePublicAppUrl } from '../public-url';

/** CR-2026-106 — customer-facing links come from ONE public base (docs/121 §C4). */

describe('resolvePublicAppUrl / publicUrl', () => {
  it('prefers PUBLIC_APP_URL and strips a trailing slash', () => {
    expect(resolvePublicAppUrl({ PUBLIC_APP_URL: 'https://service.berts.example/', API_CORS_ORIGIN: 'http://localhost:3000' })).toBe(
      'https://service.berts.example',
    );
    expect(publicUrl('/status/abc', { PUBLIC_APP_URL: 'https://service.berts.example' })).toBe('https://service.berts.example/status/abc');
    expect(publicUrl('book/manage/t', { PUBLIC_APP_URL: 'https://service.berts.example' })).toBe('https://service.berts.example/book/manage/t');
  });

  it('falls back to the FIRST CORS origin only when nothing public is configured', () => {
    expect(resolvePublicAppUrl({ API_CORS_ORIGIN: 'http://192.168.1.20:3000, http://localhost:3000' })).toBe('http://192.168.1.20:3000');
    expect(publicUrl('/status/x', {})).toBe('http://localhost:3000/status/x');
  });
});

describe('isPrivateOrLocalHost', () => {
  it('flags every address a customer phone cannot reach', () => {
    for (const h of ['localhost', 'api.localhost', '127.0.0.1', '10.0.0.5', '172.16.4.4', '172.31.255.1', '192.168.1.20', '169.254.1.1', '100.64.0.1', 'frontdesk.lan', 'server.local'])
      expect(isPrivateOrLocalHost(h), h).toBe(true);
  });
  it('accepts public hosts', () => {
    for (const h of ['bsop-web.onrender.com', 'service.berts.com', '172.32.0.1', '8.8.8.8']) expect(isPrivateOrLocalHost(h), h).toBe(false);
  });
});

describe('assessPublicAppUrl (production readiness)', () => {
  it('fails when unset, non-https, or internal', () => {
    expect(assessPublicAppUrl({}).ok).toBe(false);
    expect(assessPublicAppUrl({ PUBLIC_APP_URL: 'http://bsop-web.onrender.com' }).ok).toBe(false);
    expect(assessPublicAppUrl({ PUBLIC_APP_URL: 'https://192.168.1.20:3000' }).ok).toBe(false);
    expect(assessPublicAppUrl({ PUBLIC_APP_URL: 'not a url' }).ok).toBe(false);
  });
  it('passes a public https base', () => {
    expect(assessPublicAppUrl({ PUBLIC_APP_URL: 'https://bsop-web.onrender.com/' })).toEqual({
      ok: true,
      reason: 'publicly reachable',
      value: 'https://bsop-web.onrender.com',
    });
  });
});
