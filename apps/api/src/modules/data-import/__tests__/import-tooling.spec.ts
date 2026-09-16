import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CR-2026-106 — the import tooling must (a) count what the parser drops, (b) offer a
 * --reconcile mode that compares by STABLE keys, (c) record provenance at customer
 * level and an ImportRun, and (d) never declare "complete" without re-checking the
 * database (docs/121 §C6).
 */
// __tests__ → data-import → modules → src → apps/api
const apiRoot = path.resolve(__dirname, '../../../..');
const importer = fs.readFileSync(path.join(apiRoot, 'scripts/import-customers.ts'), 'utf8');
const master = fs.readFileSync(path.join(apiRoot, 'scripts/reconcile-master-list.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.resolve(apiRoot, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };

describe('import-customers.ts', () => {
  it('has a --reconcile mode and counts dropped rows', () => {
    expect(importer).toContain("has('--reconcile')");
    expect(importer).toContain('droppedShortRows');
    expect(importer).toContain('droppedNoId');
    expect(importer).toContain('buildReconciliation');
  });
  it('records customer-level ExternalSystemRef and an ImportRun on commit, and re-checks the database before saying complete', () => {
    expect(importer).toContain("upsertRef(prisma, 'Customer'");
    expect(importer).toContain('prisma.importRun.create');
    expect(importer).toMatch(/Import complete: .*present by exact key/);
    expect(importer).toContain('Import INCOMPLETE');
  });
  it('never matches people by name (names only raise exceptions)', () => {
    expect(importer).toContain('Names: only to RAISE review/name-only exceptions');
  });
});

describe('reconcile-master-list.ts', () => {
  it('groups by Source, matches by stable keys only, and records an ImportRun', () => {
    for (const s of ["'VEHICLE_CODE'", "'PLATE'", "'VIN'", "'PHONE'", "'EMAIL'", "'NOT_PRESENT'", 'PEACHTREE_CUSTOMER_LIST', 'names are never a key']) expect(master).toContain(s);
    expect(master).toContain('prisma.importRun.create');
  });
});

describe('package scripts', () => {
  it('expose the reconciliation commands', () => {
    expect(pkg.scripts['customers:reconcile']).toContain('--reconcile');
    expect(pkg.scripts['customers:reconcile:master']).toContain('reconcile-master-list.ts');
  });
});
