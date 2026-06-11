import { describe, it, expect } from 'vitest';
import {
  splitSegments, similarity, buildCatalogIndex, classifyMatch, segmentHash, redact,
  type CatalogRef,
} from '../service-match';

const CATALOG: CatalogRef[] = [
  { id: 'c1', name: 'Oil Change', normalizedName: 'oil change', category: 'SERVICE' },
  { id: 'c2', name: 'Brake Pad Replacement', normalizedName: 'brake pad replacement', category: 'BRAKES' },
];
const idx = buildCatalogIndex(CATALOG);

describe('splitSegments', () => {
  it('splits on safe delimiters, strips the importer prefix, drops tiny fragments', () => {
    expect(splitSegments('[hist source_status=Completed] Oil Change | brake pad replacement; left a note'))
      .toEqual(['Oil Change', 'brake pad replacement', 'left a note']);
    expect(splitSegments('  a  ')).toEqual([]); // too short
  });
  it('does NOT split on / , + & - (catalog names use them)', () => {
    expect(splitSegments('R/R Hub -CAR')).toEqual(['R/R Hub -CAR']);
    expect(splitSegments('Oil & Air Filter, Car')).toEqual(['Oil & Air Filter, Car']);
  });
  it('strips HTML rich-text + inline CSS; block tags become segment boundaries', () => {
    const html = '<div style="font-size:11pt;color:#585858">R/R Rack and Pinion</div><div>Clean headlamps&#160;</div>';
    expect(splitSegments(html)).toEqual(['R/R Rack and Pinion', 'Clean headlamps']);
  });
});

describe('similarity', () => {
  it('is 1 for identical, high for typos, low for unrelated', () => {
    expect(similarity('oil change', 'oil change')).toBe(1);
    expect(similarity('brake pad replacement', 'brake pad replacment')).toBeGreaterThan(0.8);
    expect(similarity('oil change', 'transmission flush')).toBeLessThan(0.5);
  });
});

describe('classifyMatch', () => {
  it('EXACT name -> AUTO_MATCHED', () => {
    const m = classifyMatch('Oil Change', idx, 0.6);
    expect(m).toMatchObject({ method: 'EXACT', status: 'AUTO_MATCHED', catalogItemId: 'c1', category: 'SERVICE' });
  });
  it('NORMALIZED (case/punct) -> AUTO_MATCHED', () => {
    const m = classifyMatch('  oil  change! ', idx, 0.6);
    expect(m).toMatchObject({ method: 'NORMALIZED', status: 'AUTO_MATCHED', catalogItemId: 'c1' });
  });
  it('FUZZY (typo) -> NEEDS_REVIEW, never auto-confirmed', () => {
    const m = classifyMatch('Brake Pad Replacment', idx, 0.6);
    expect(m.method).toBe('FUZZY');
    expect(m.status).toBe('NEEDS_REVIEW');
    expect(m.catalogItemId).toBe('c2');
    expect(m.confidence).toBeGreaterThanOrEqual(0.6);
  });
  it('below threshold -> UNMAPPED', () => {
    const m = classifyMatch('customer waiting in the lobby', idx, 0.6);
    expect(m.status).toBe('UNMAPPED');
    expect(m.method).toBe('NONE');
    expect(m.catalogItemId).toBeNull();
  });
});

describe('segmentHash (idempotency key)', () => {
  it('is deterministic and format-insensitive within a scope', () => {
    expect(segmentHash('order1', 'Oil Change')).toBe(segmentHash('order1', 'oil  change'));
  });
  it('differs across scopes and across segments', () => {
    expect(segmentHash('order1', 'Oil Change')).not.toBe(segmentHash('order2', 'Oil Change'));
    expect(segmentHash('order1', 'Oil Change')).not.toBe(segmentHash('order1', 'Brake Pad'));
  });
});

describe('redact', () => {
  it('masks long digit runs (PII-ish) and caps length', () => {
    expect(redact('call 8765414056 now')).toBe('call #### now');
    expect(redact('x'.repeat(80)).length).toBeLessThanOrEqual(60);
  });
});
