/**
 * CR-2026-092 — the visual-QA route must never be reachable in production, and must
 * never render anything real.
 *
 * These are source-level assertions rather than a running-app check on purpose: the
 * risk is a future edit quietly removing the guard or wiring the page to a live
 * endpoint, and that shows up in the source long before anyone would think to point a
 * browser at production to find out.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const VISUAL_QA = path.join(ROOT, 'app/dev/visual-qa/kpi/page.tsx');
const DISPLAY = path.join(ROOT, 'app/display/[token]/page.tsx');
const CAPTURE_SCRIPT = path.resolve(ROOT, '../../scripts/capture-kpi-screenshots.mjs');

const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('the visual-QA route is gated', () => {
  it('exists', () => {
    expect(fs.existsSync(VISUAL_QA)).toBe(true);
  });

  it('refuses to render in production', () => {
    const src = read(VISUAL_QA);
    expect(src).toMatch(/NODE_ENV/);
    expect(src).toMatch(/production/);
  });

  it('requires an explicit opt-in flag as well as a non-production build', () => {
    // Non-production alone is not enough: a staging build is not production, and this
    // page should still be off there unless somebody deliberately turned it on.
    const src = read(VISUAL_QA);
    expect(src).toMatch(/ENABLE_VISUAL_QA/);
  });

  it('returns 404 rather than an error page when disabled', () => {
    expect(read(VISUAL_QA)).toMatch(/notFound\(\)/);
  });
});

describe('the visual-QA route uses synthetic data only', () => {
  const src = read(VISUAL_QA);

  it('makes no live API calls', () => {
    expect(src).not.toMatch(/from ['"].*lib\/api-client['"]/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/useQuery\b/);
  });

  it('carries no real customer or vehicle identifiers', () => {
    // A Jamaican plate is three letters and four digits; a local mobile is 876-xxx-xxxx.
    expect(src).not.toMatch(/\b[A-Z]{3}\s?\d{4}\b/);
    expect(src).not.toMatch(/\b876[-\s]?\d{3}[-\s]?\d{4}\b/);
    expect(src).not.toMatch(/@bert\.local/);
  });

  it('labels its sample data as sample data', () => {
    expect(src.toUpperCase()).toMatch(/SAMPLE|SYNTHETIC|DEMO/);
  });
});

describe('the customer display leaks no KPI information', () => {
  const src = read(DISPLAY);

  it('shows no rating band', () => {
    // A customer in the lobby must never read a technician's performance rating.
    for (const banned of [
      'EXCELLENT',
      'MEETS_TARGET',
      'NEEDS_IMPROVEMENT',
      'BELOW_STANDARD',
      'adjustedTechnicianRating',
      'absoluteCompletionRating',
    ]) {
      expect(src, banned).not.toContain(banned);
    }
  });

  it('shows no benchmark or standard', () => {
    for (const banned of [
      'standardMinutes',
      'benchmarkSource',
      'calculationBreakdown',
      'varianceMinutes',
      'kpiCompletionMinutes',
    ]) {
      expect(src, banned).not.toContain(banned);
    }
  });

  it('does not import the KPI strip or calculation panel', () => {
    expect(src).not.toMatch(/kpi-strip/);
    expect(src).not.toMatch(/kpi-calculation-panel/);
  });
});

describe('the screenshot script fails loudly', () => {
  const src = read(CAPTURE_SCRIPT);

  it('exists', () => {
    expect(fs.existsSync(CAPTURE_SCRIPT)).toBe(true);
  });

  it('exits non-zero rather than reporting success it did not achieve', () => {
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  it('probes the route before trying to capture it', () => {
    // Capturing a 404 produces a real PNG of an error page, which is worse than
    // failing: it looks like evidence.
    expect(src.toLowerCase()).toMatch(/fetch|http|probe|reachable/);
  });

  it('reports which browser executable it used', () => {
    expect(src.toLowerCase()).toMatch(/executable|browser/);
  });
});
