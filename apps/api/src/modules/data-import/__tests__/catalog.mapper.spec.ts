import { describe, it, expect } from 'vitest';
import {
  selectImportSheets, normalizeName, parsePrice, findHeader, parseGrid, dedupeExact,
  CATEGORY_SHEETS,
} from '../catalog.mapper';

/**
 * CR-2026-019 (P1a) — catalog parser/normalizer. Pure, synthetic grids only.
 * No real workbook, no PII fixture (the PII tab is never represented here).
 */

// Mimics the real category-sheet layout: boilerplate, then header, then data.
function sampleGrid(): string[][] {
  return [
    ['', '', '', '', '', '', '', 'Prices are estimated costs and are subject to change', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['', 'The Service Center charges 10% of all outsourced', '', '', '', '', '', '', ''],
    ['', 'TYPE OF SERVICE', 'PRICE', '', '', '', 'NEW PRICE', 'TAX PRICE', 'COMMENTS'], // header at row 3, nameCol=1
    ['', 'Prices are estimated costs and are subject to change', '', '', '', '', '', '', ''], // boilerplate below header -> skipped
    ['', 'Oil Change', '2000', '2200', '2420', '2900', '3335', '3835.25', 'HRV'],
    ['', 'Coil Pack', '500', '600', '750', '1494.9999999999998', '1719.25', '', ''],
    ['', 'Blank Price Job', '', '', '', '', '', '', ''],
    ['', 'Zero Job', '', '', '', '0', '', '', ''],
    ['', 'Oil Change', '', '', '', '3000', '', '', ''], // same name, different price -> variant kept
    ['', 'Oil Change', '2000', '2200', '2420', '2900', '3335', '3835.25', 'HRV'], // EXACT repeat of row 5
    ['', '', '', '', '', '', '', '', ''], // empty -> skipped
  ];
}

describe('selectImportSheets', () => {
  it('returns only the 13 category tabs and never excluded/PII tabs', () => {
    const got = selectImportSheets(['SERVICE', 'Sheet2', 'CAR CLASSIFICATION', 'BRAKES', 'MASTER PRICE LIST', 'Job Classification', 'Sheet1', 'UNKNOWN']);
    expect(got).toEqual(['SERVICE', 'BRAKES']); // canonical order
    expect(got).not.toContain('Sheet2');
    expect(got).not.toContain('CAR CLASSIFICATION');
    expect(got).not.toContain('MASTER PRICE LIST');
  });
  it('canonical list has the 13 expected categories', () => {
    expect(CATEGORY_SHEETS).toHaveLength(13);
    expect(CATEGORY_SHEETS).toContain('BRAKES');
    expect(CATEGORY_SHEETS).not.toContain('Sheet2');
  });
});

describe('normalizeName', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeName('A/C  Filter!')).toBe('a c filter');
    expect(normalizeName('  R/R Hub -CAR ')).toBe('r r hub car');
  });
});

describe('parsePrice', () => {
  it('rounds float artifacts to 2 dp', () => {
    const p = parsePrice('1494.9999999999998');
    expect(p.value).toBe(1495);
    expect(p.wasRounded).toBe(true);
  });
  it('treats blank and zero as null', () => {
    expect(parsePrice('').value).toBeNull();
    expect(parsePrice('').wasNonNumeric).toBe(false);
    const z = parsePrice('0');
    expect(z.value).toBeNull();
    expect(z.wasZero).toBe(true);
  });
  it('treats non-numeric text as null (flagged)', () => {
    const n = parsePrice('EST UP');
    expect(n.value).toBeNull();
    expect(n.wasNonNumeric).toBe(true);
  });
  it('passes clean integers through', () => {
    expect(parsePrice('2900').value).toBe(2900);
  });
});

describe('findHeader', () => {
  it('locates the TYPE OF SERVICE header row + name column', () => {
    expect(findHeader(sampleGrid())).toEqual({ headerRow: 3, nameCol: 1 });
  });
});

describe('parseGrid', () => {
  const { items, stats } = parseGrid(sampleGrid(), 'BRAKES', 'PRICE_LIST_2026');

  it('parses data rows only (skips boilerplate/header/empty)', () => {
    expect(items.map((i) => i.name)).toEqual(['Oil Change', 'Coil Pack', 'Blank Price Job', 'Zero Job', 'Oil Change', 'Oil Change']);
  });
  it('maps basePrice=col F and priceTaxInclusive=col G; rounds; zero/blank -> null', () => {
    const oil = items[0];
    expect(oil.basePrice).toBe(2900);
    expect(oil.priceTaxInclusive).toBe(3335);
    expect(items[1].basePrice).toBe(1495); // rounded
    expect(items[2].basePrice).toBeNull(); // blank
    expect(items[3].basePrice).toBeNull(); // zero
  });
  it('sets category, currency, null jobCode/labor/parts and preserves rawImportRow', () => {
    const oil = items[0];
    expect(oil.category).toBe('BRAKES');
    expect(oil.currency).toBe('JMD');
    expect(oil.jobCode).toBeNull();
    expect(oil.laborPrice).toBeNull();
    expect(oil.partsPrice).toBeNull();
    expect(oil.rawImportRow.priceF).toBe('2900');
    expect(oil.rawImportRow.comment).toBe('HRV');
  });
  it('reports per-sheet stats (missing/zero/rounded/duplicates)', () => {
    expect(stats.dataRows).toBe(6);
    expect(stats.missingBasePrice).toBe(1);
    expect(stats.zeroBasePrice).toBe(1);
    expect(stats.roundedCells).toBeGreaterThanOrEqual(1);
    expect(stats.duplicateNameRows).toBe(2); // two extra "oil change" rows
  });
});

describe('dedupeExact', () => {
  it('collapses exact full-row repeats but keeps same-name/different-price variants', () => {
    const { items } = parseGrid(sampleGrid(), 'BRAKES', 'PRICE_LIST_2026');
    const { items: deduped, collapsed } = dedupeExact(items);
    expect(collapsed).toBe(1); // the exact "Oil Change 2900" repeat
    expect(deduped).toHaveLength(5);
    const oilVariants = deduped.filter((i) => i.normalizedName === 'oil change');
    expect(oilVariants.map((i) => i.basePrice).sort()).toEqual([2900, 3000]); // both variants kept
  });
});
