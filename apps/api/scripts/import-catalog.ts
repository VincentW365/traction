/**
 * Service Catalog / Price List importer (CR-2026-019, P1a).
 *
 *   (default)            DRY-RUN — parse the 13 category tabs, summarise, write a
 *                        JSON report to demo-output/. NO DB writes. NO PII.
 *   --commit             [GATED] Upsert ServiceCatalogItem rows (idempotent by
 *                        rowHash, batch-tagged). Requires the migration applied.
 *   --rollback <batchId> [GATED] Delete a committed batch.
 *   --file <path>        REQUIRED: the price-list .xlsx (kept OUTSIDE the repo — PII)
 *
 * Guardrails: import ONLY the 13 category tabs; the PII tab `Sheet2` is never
 * read/logged; MASTER PRICE LIST is cross-check only; blank/zero -> null; float
 * artifacts rounded to 2 dp; full included-row provenance kept in rawImportRow.
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openXlsx } from '../src/modules/data-import/xlsx-lite';
import {
  selectImportSheets, parseGrid, dedupeExact, normalizeName,
  CATEGORY_SHEETS, EXCLUDED_SHEETS, MASTER_SHEET,
  type ParsedCatalogItem, type SheetParseStats,
} from '../src/modules/data-import/catalog.mapper';

const SOURCE = 'PRICE_LIST_2026';
const OUT_DIR = 'demo-output';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const MODE = has('--rollback') ? 'rollback' : has('--commit') ? 'commit' : 'dry-run';
// Deployment-parity audit (2026-09): no personal-machine default path. The source
// workbook lives outside the repo and must be named explicitly on every run.
const FILE = val('--file') ?? '';
if (!FILE && MODE !== 'rollback') {
  console.error('Usage: tsx apps/api/scripts/import-catalog.ts --file <path-to-price-list.xlsx> [--commit]');
  console.error('The price-list workbook is not in the repository; pass its location explicitly.');
  process.exit(1);
}

function runDryRun() {
  const wbk = openXlsx(FILE);
  const allTabs = [...wbk.sheetFileByName.keys()];
  const selected = selectImportSheets(allTabs);

  // Hard PII guard: Sheet2 must never be selected/read.
  if (selected.includes('Sheet2')) throw new Error('GUARD: Sheet2 (PII) ended up in the import selection — aborting');
  const excludedPresent = EXCLUDED_SHEETS.filter((s) => allTabs.includes(s));

  const perCategory: SheetParseStats[] = [];
  let all: ParsedCatalogItem[] = [];
  for (const name of selected) {
    const { items, stats } = parseGrid(wbk.readGrid(name), name, SOURCE);
    perCategory.push(stats);
    all = all.concat(items);
  }

  const { items: deduped, collapsed } = dedupeExact(all);

  // Cross-check against MASTER PRICE LIST (names only; not imported).
  let crossCheck: Record<string, number> = {};
  if (allTabs.includes(MASTER_SHEET)) {
    const masterNames = new Set(parseGrid(wbk.readGrid(MASTER_SHEET), MASTER_SHEET, SOURCE).items.map((i) => i.normalizedName));
    const importNames = new Set(deduped.map((i) => i.normalizedName));
    let inBoth = 0; importNames.forEach((n) => { if (masterNames.has(n)) inBoth++; });
    let importNotInMaster = 0; importNames.forEach((n) => { if (!masterNames.has(n)) importNotInMaster++; });
    let masterNotImported = 0; masterNames.forEach((n) => { if (!importNames.has(n)) masterNotImported++; });
    crossCheck = { masterDistinctNames: masterNames.size, importDistinctNames: importNames.size, inBoth, importNamesNotInMaster: importNotInMaster, masterNamesNotImported: masterNotImported };
  }

  const totals = {
    totalRowsParsed: all.length,
    afterExactDedup: deduped.length,
    exactDuplicateRowsCollapsed: collapsed,
    variantSameNameRowsKept: deduped.length - new Set(deduped.map((i) => i.normalizedName)).size,
    missingBasePrice: perCategory.reduce((a, s) => a + s.missingBasePrice, 0),
    zeroBasePriceAsNull: perCategory.reduce((a, s) => a + s.zeroBasePrice, 0),
    nonNumericBasePrice: perCategory.reduce((a, s) => a + s.nonNumericBasePrice, 0),
    roundedPriceCells: perCategory.reduce((a, s) => a + s.roundedCells, 0),
    withBasePrice: deduped.filter((i) => i.basePrice !== null).length,
    withTaxInclusive: deduped.filter((i) => i.priceTaxInclusive !== null).length,
  };

  // ----- console report (non-PII) -----
  console.log(`\n=== CATALOG DRY-RUN (${FILE}) ===`);
  console.log(`Workbook tabs: ${allTabs.length}. Selected for import: ${selected.length} of ${CATEGORY_SHEETS.length} category tabs.`);
  console.log(`Sheet2 (PII) present in workbook: ${allTabs.includes('Sheet2') ? 'YES' : 'no'} | read: NO | excluded: YES`);
  console.log(`Other excluded tabs present: ${excludedPresent.filter((s) => s !== 'Sheet2').join(', ') || '(none)'}`);
  console.log(`\n-- rows by category --`);
  for (const s of perCategory) {
    console.log(`  ${s.category.padEnd(16)} rows=${String(s.dataRows).padStart(3)}  missingBase=${s.missingBasePrice}  zero->null=${s.zeroBasePrice}  nonNumeric=${s.nonNumericBasePrice}  dupNameVariants=${s.duplicateNameRows}  rounded=${s.roundedCells}`);
  }
  console.log(`\n-- totals --`);
  console.log(JSON.stringify(totals, null, 2));
  console.log(`\n-- cross-check vs MASTER PRICE LIST --`);
  console.log(JSON.stringify(crossCheck, null, 2));
  console.log(`\n-- sample parsed items (first 5; names/prices only) --`);
  for (const it of deduped.slice(0, 5)) {
    console.log(`  [${it.category}] "${it.name}" base=${it.basePrice ?? 'null'} tax=${it.priceTaxInclusive ?? 'null'}`);
  }

  // ----- full JSON report to gitignored demo-output (non-PII; Sheet2 never touched) -----
  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, 'catalog-dry-run.json');
  writeFileSync(reportPath, JSON.stringify({ file: FILE, source: SOURCE, allTabs, selected, excludedPresent, sheet2Read: false, perCategory, totals, crossCheck, items: deduped }, null, 2));
  console.log(`\nFull report written to ${reportPath} (gitignored). NO DB writes. NO PII logged.`);
}

async function runCommit() {
  // GATED — only after dry-run review + migration applied.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const batchId = randomUUID();
  const now = new Date();
  try {
    const wbk = openXlsx(FILE);
    const selected = selectImportSheets([...wbk.sheetFileByName.keys()]);
    if (selected.includes('Sheet2')) throw new Error('GUARD: Sheet2 in selection');
    let all: ParsedCatalogItem[] = [];
    for (const name of selected) all = all.concat(parseGrid(wbk.readGrid(name), name, SOURCE).items);
    const { items } = dedupeExact(all);
    for (const it of items) {
      await (prisma as any).serviceCatalogItem.upsert({
        where: { rowHash: it.rowHash },
        update: { basePrice: it.basePrice, priceTaxInclusive: it.priceTaxInclusive, category: it.category, active: true },
        create: {
          jobCode: it.jobCode, name: it.name, normalizedName: it.normalizedName, category: it.category,
          subcategory: it.subcategory, basePrice: it.basePrice, priceTaxInclusive: it.priceTaxInclusive,
          laborPrice: it.laborPrice, partsPrice: it.partsPrice, currency: it.currency,
          effectiveFrom: now, active: true, source: it.source, rawImportRow: it.rawImportRow,
          rowHash: it.rowHash, importBatchId: batchId,
        },
      });
    }
    console.log(`Committed ${items.length} catalog items. batchId=${batchId}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function runRollback(batchId: string) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const res = await (prisma as any).serviceCatalogItem.deleteMany({ where: { importBatchId: batchId } });
    console.log(`Rolled back batch ${batchId}: deleted ${res.count}`);
  } finally {
    await prisma.$disconnect();
  }
}

(async () => {
  if (MODE === 'dry-run') runDryRun();
  else if (MODE === 'commit') await runCommit();
  else await runRollback(val('--rollback')!);
})().catch((e) => { console.error('catalog import error:', e?.message ?? e); process.exit(1); });
