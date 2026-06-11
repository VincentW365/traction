/**
 * Service catalog / price-list parser (CR-2026-019, P1a). Pure + dependency-free
 * (no DB, no PII). Turns a worksheet grid (string[][]) into catalog items.
 *
 * Decisions baked in (owner-approved):
 *  - basePrice = column F (current pre-tax estimate); priceTaxInclusive = col G.
 *  - C, D, E, F, G, H + comment preserved verbatim in rawImportRow.
 *  - currency = "JMD". laborPrice/partsPrice = null (file has no split).
 *  - no jobCode in the source. Duplicate names are KEPT as distinct variants;
 *    only EXACT full-row repeats dedupe (via rowHash).
 *  - blank/zero price cells -> null; float artifacts rounded to 2 dp.
 *  - import ONLY the 13 category tabs; the PII tab is never selected/parsed.
 */
import { createHash } from 'node:crypto';

/** The 13 category tabs to import (exact workbook tab names). Category = the tab. */
export const CATEGORY_SHEETS: readonly string[] = [
  'SERVICE',
  'ENGINE & OTHER',
  'FULL SERVICE',
  'TRANSMISSIONS',
  'FUEL FILTERS',
  'RADIATOR',
  'ENGINE MOUNTS',
  'SUSPENSION',
  'BRAKES',
  'STEERING',
  'DRIVETRAIN',
  'LIGHTING & BODY',
  'CAR CARE',
];

/** Cross-check only — never an import source. */
export const MASTER_SHEET = 'MASTER PRICE LIST';

/** Explicitly excluded from P1a. `Sheet2` is PII and must never be read. */
export const EXCLUDED_SHEETS: readonly string[] = [
  'Sheet2', // PII (staff DOB / emergency contacts) — never parse/log/export
  'CAR CLASSIFICATION',
  'Job Classification',
  'Sheet1',
  MASTER_SHEET,
];

/**
 * From the workbook's actual tab names, choose the import set: the intersection
 * with CATEGORY_SHEETS, in canonical order. Excluded tabs (incl. PII) are never
 * returned. This is the single gate that keeps Sheet2 out of the pipeline.
 */
export function selectImportSheets(allNames: string[]): string[] {
  const present = new Set(allNames);
  return CATEGORY_SHEETS.filter((c) => present.has(c));
}

export function normalizeName(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ') // strip punctuation -> spaces
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PriceParse {
  value: number | null;
  wasZero: boolean;
  wasRounded: boolean;
  wasNonNumeric: boolean;
}

/** Parse a price cell: blank/zero -> null; round float artifacts to 2 dp. */
export function parsePrice(raw: string | undefined): PriceParse {
  const s = (raw ?? '').trim();
  if (s === '') return { value: null, wasZero: false, wasRounded: false, wasNonNumeric: false };
  if (!/^\d+(\.\d+)?$/.test(s)) return { value: null, wasZero: false, wasRounded: false, wasNonNumeric: true };
  const n = parseFloat(s);
  if (n === 0) return { value: null, wasZero: true, wasRounded: false, wasNonNumeric: false };
  const rounded = Math.round(n * 100) / 100;
  return { value: rounded, wasZero: false, wasRounded: rounded !== n, wasNonNumeric: false };
}

const BOILERPLATE = /prices are estimated|the service center|type of service/i;

/** Find the header row (the one containing "TYPE OF SERVICE") and its name column. */
export function findHeader(grid: string[][]): { headerRow: number; nameCol: number } | null {
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if ((grid[r][c] || '').trim().toUpperCase() === 'TYPE OF SERVICE') {
        return { headerRow: r, nameCol: c };
      }
    }
  }
  return null;
}

export interface ParsedCatalogItem {
  jobCode: string | null;
  name: string;
  normalizedName: string;
  category: string;
  subcategory: string | null;
  basePrice: number | null;
  priceTaxInclusive: number | null;
  laborPrice: number | null;
  partsPrice: number | null;
  currency: string;
  source: string;
  rawImportRow: Record<string, string>;
  rowHash: string;
}

export interface SheetParseStats {
  category: string;
  dataRows: number;
  missingBasePrice: number;
  zeroBasePrice: number;
  nonNumericBasePrice: number;
  roundedCells: number;
  distinctNames: number;
  duplicateNameRows: number;
}

function cell(row: string[], i: number): string {
  return (row[i] ?? '').trim();
}

/** Parse one category sheet grid into catalog items + per-sheet stats. */
export function parseGrid(grid: string[][], category: string, source: string): { items: ParsedCatalogItem[]; stats: SheetParseStats } {
  const items: ParsedCatalogItem[] = [];
  let missingBasePrice = 0;
  let zeroBasePrice = 0;
  let nonNumericBasePrice = 0;
  let roundedCells = 0;
  const header = findHeader(grid);
  const startRow = header ? header.headerRow + 1 : 0;
  const nameCol = header ? header.nameCol : 1;

  for (let r = startRow; r < grid.length; r++) {
    const row = grid[r];
    const name = cell(row, nameCol);
    if (name === '' || BOILERPLATE.test(name)) continue;

    // columns relative to the name column: C..H then comment
    const cC = cell(row, nameCol + 1);
    const cD = cell(row, nameCol + 2);
    const cE = cell(row, nameCol + 3);
    const cF = cell(row, nameCol + 4); // basePrice
    const cG = cell(row, nameCol + 5); // priceTaxInclusive
    const cH = cell(row, nameCol + 6);
    const comment = cell(row, nameCol + 7);

    const base = parsePrice(cF);
    const tax = parsePrice(cG);
    if (base.value === null) {
      if (base.wasZero) zeroBasePrice++;
      else if (base.wasNonNumeric) nonNumericBasePrice++;
      else missingBasePrice++;
    }
    for (const p of [base, tax, parsePrice(cC), parsePrice(cD), parsePrice(cE), parsePrice(cH)]) {
      if (p.wasRounded) roundedCells++;
    }

    const rawImportRow: Record<string, string> = {
      sheet: category,
      rowIndex: String(r),
      name,
      priceC: cC,
      priceD: cD,
      priceE: cE,
      priceF: cF,
      priceG: cG,
      priceH: cH,
      comment,
    };
    const rowHash = createHash('sha256').update(JSON.stringify([category, name, cC, cD, cE, cF, cG, cH, comment])).digest('hex');

    items.push({
      jobCode: null,
      name,
      normalizedName: normalizeName(name),
      category,
      subcategory: null,
      basePrice: base.value,
      priceTaxInclusive: tax.value,
      laborPrice: null,
      partsPrice: null,
      currency: 'JMD',
      source,
      rawImportRow,
      rowHash,
    });
  }

  const names = items.map((i) => i.normalizedName);
  const distinct = new Set(names);
  return {
    items,
    stats: {
      category,
      dataRows: items.length,
      missingBasePrice,
      zeroBasePrice,
      nonNumericBasePrice,
      roundedCells,
      distinctNames: distinct.size,
      duplicateNameRows: items.length - distinct.size,
    },
  };
}

/** Collapse EXACT full-row repeats (same rowHash); keep same-name/diff-price variants. */
export function dedupeExact(items: ParsedCatalogItem[]): { items: ParsedCatalogItem[]; collapsed: number } {
  const seen = new Set<string>();
  const out: ParsedCatalogItem[] = [];
  let collapsed = 0;
  for (const it of items) {
    if (seen.has(it.rowHash)) { collapsed++; continue; }
    seen.add(it.rowHash);
    out.push(it);
  }
  return { items: out, collapsed };
}
