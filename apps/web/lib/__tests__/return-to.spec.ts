import { describe, it, expect } from 'vitest';
import { isInternalPath, safeReturnPath, withReturn, returnLabel } from '../return-to';

/**
 * CR-2026-118 §4 — a form must return to the job it was opened from, and the
 * origin travels in the URL. The part worth testing hard is the validation:
 * `from` is user-controllable, so it can only ever point back INSIDE the app.
 */

describe('what counts as an internal path', () => {
  it('accepts a root-relative path', () => {
    expect(isInternalPath('/queue/abc')).toBe(true);
    expect(isInternalPath('/technician/jobs/x?tab=1')).toBe(true);
  });

  it('rejects anything that could leave the application', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example/queue',       // protocol-relative
      'javascript:alert(1)',
      '/javascript:alert(1)',       // scheme smuggled after the slash
      '\\\\evil.example',           // backslash tricks
      '/queue\u0000/x',             // control characters
      'queue/abc',                  // not root-relative
      '',
      null,
      undefined,
    ]) {
      expect(isInternalPath(bad as never)).toBe(false);
    }
  });
});

describe('the return path', () => {
  it('uses the origin when it is safe', () => {
    expect(safeReturnPath('/queue/t1', '/visits/v1')).toBe('/queue/t1');
  });

  it('falls back to the visit when the origin is missing or unsafe', () => {
    // §5.4F — a direct link prefers the associated visit, never a general page.
    expect(safeReturnPath(null, '/visits/v1')).toBe('/visits/v1');
    expect(safeReturnPath('https://evil.example', '/visits/v1')).toBe('/visits/v1');
  });
});

describe('carrying the origin into a document link', () => {
  it('appends the encoded origin', () => {
    expect(withReturn('/inspections/i1', '/queue/t1')).toBe('/inspections/i1?from=%2Fqueue%2Ft1');
  });

  it('uses & when the link already has a query', () => {
    expect(withReturn('/inspections/i1?tab=photos', '/queue/t1')).toBe('/inspections/i1?tab=photos&from=%2Fqueue%2Ft1');
  });

  it('adds nothing for a missing or unsafe origin', () => {
    expect(withReturn('/inspections/i1', null)).toBe('/inspections/i1');
    expect(withReturn('/inspections/i1', '//evil.example')).toBe('/inspections/i1');
  });

  it('survives a round trip through the URL', () => {
    const href = withReturn('/inspections/i1', '/technician/jobs/o9');
    const from = new URL(href, 'http://x').searchParams.get('from');
    expect(safeReturnPath(from, '/visits/v1')).toBe('/technician/jobs/o9');
  });
});

describe('the back control names where it goes', () => {
  it.each([
    ['/queue/t1', 'Back to Job'],
    ['/technician/jobs/o1', 'Back to My Job'],
    ['/technician', 'Back to My Jobs'],
    ['/visits/v1', 'Back to Visit Record'],
    ['/vehicles/v1', 'Back to Vehicle'],
    ['/customers/c1', 'Back to Customer'],
    ['/inspections', 'Back to Inspections'],
    ['/somewhere-else', 'Back'],
  ])('%s → %s', (path, label) => {
    expect(returnLabel(path)).toBe(label);
  });
});
