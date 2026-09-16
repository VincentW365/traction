import { describe, it, expect } from 'vitest';
import { planImport, type RawContactRow } from '../customer-vehicle.mapper';
import { buildReconciliation, exceptionsCsv, reconciliationTotals, renderReconciliationMarkdown, type DbCustomerLookup, type DbVehicleLookup } from '../reconcile';

/** CR-2026-106 — the reconciliation table adds up to the source and never matches by name alone. */

const row = (id: string, name: string, phone: string, plate: string, extra: Partial<RawContactRow> = {}): RawContactRow => ({
  id, title: `SC${plate}`, name, phone, year: '2018', make: 'Toyota', model: 'Corolla', plate, chassis: `VIN${id}`, email: '', loyalty: '', fuel: '', transmission: '', drivetrain: '', engineNo: '', ...extra,
});

const emptyDb = (): { c: DbCustomerLookup; v: DbVehicleLookup } => ({
  c: { byCustomerNumber: new Set(), byPhone: new Map(), byEmail: new Map(), byName: new Map() },
  v: { byVehicleCode: new Set(), byPlate: new Map(), byVin: new Map() },
});

describe('buildReconciliation', () => {
  const rows = [row('1', 'Jane Doe', '876-555-0100', '1234AB'), row('2', 'John Smith', '876-555-0200', '5678CD'), row('3', 'Ann Lee', '876-555-0300', '9999EF', { email: 'ann@example.com' })];
  const plan = planImport(rows);
  const source = { rowsInFile: 5, parsed: 4, droppedShortRows: 1, droppedNoId: 1 };

  it('empty database → everything would be created; source rows reconcile (parsed − noId = planned rows)', () => {
    const db = emptyDb();
    const r = buildReconciliation(source, plan, db.c, db.v);
    expect(r.source.reconciles).toBe(true);
    expect(r.customers).toMatchObject({ planned: 3, exactKey: 0, byPhone: 0, byEmail: 0, wouldCreate: 3, nameReview: 0, reconciles: true });
    expect(r.vehicles).toMatchObject({ planned: 3, exactKey: 0, byPlateOrVin: 0, wouldCreate: 3, reconciles: true });
    expect(r.exceptions.some((e) => e.kind === 'DROPPED_ROW')).toBe(true);
  });

  it('exact key, phone and email tiers count as matched; name-only NEVER does', () => {
    const db = emptyDb();
    const [jane, john, ann] = plan.customers;
    db.c.byCustomerNumber.add(jane.customerNumber); // already imported (idempotent key)
    db.c.byPhone.set('8765550200', ['CUST-000042']); // John's mobile on an existing record
    db.c.byEmail.set('ann@example.com', ['CUST-000043']);
    db.c.byName.set('ann lee', ['CUST-000099']); // name collision must not matter once email matched
    const r = buildReconciliation(source, plan, db.c, db.v);
    expect(r.customerTiers.get(jane.customerNumber)).toBe('EXACT_KEY');
    expect(r.customerTiers.get(john.customerNumber)).toBe('PHONE');
    expect(r.customerTiers.get(ann.customerNumber)).toBe('EMAIL');
    expect(r.customers).toMatchObject({ exactKey: 1, byPhone: 1, byEmail: 1, wouldCreate: 0, nameReview: 0, reconciles: true });
  });

  it('a name-only collision is an exception, not a match; with a plate it becomes a review item', () => {
    const db = emptyDb();
    db.c.byName.set('jane doe', ['CUST-000007']);
    const r = buildReconciliation(source, plan, db.c, db.v);
    const jane = plan.customers[0];
    // Jane has a vehicle plate in the plan → supporting attribute → REVIEW (still not merged)
    expect(r.customerTiers.get(jane.customerNumber)).toBe('NAME_REVIEW');
    expect(r.exceptions.find((e) => e.key === jane.customerNumber)?.kind).toBe('NAME_REVIEW');
    expect(r.customers.nameReview).toBe(1);
    expect(r.customers.reconciles).toBe(true);
    // Without any plate the same collision is a NAME_ONLY_CANDIDATE and the customer would be created
    const noPlate = planImport([row('9', 'Jane Doe', '876-555-0900', '')]);
    const r2 = buildReconciliation({ rowsInFile: 1, parsed: 1, droppedShortRows: 0, droppedNoId: 0 }, noPlate, db.c, db.v);
    expect([...r2.customerTiers.values()]).toEqual(['WOULD_CREATE']);
    expect(r2.exceptions.some((e) => e.kind === 'NAME_ONLY_CANDIDATE')).toBe(true);
  });

  it('a mobile shared by several records is a review item (PHONE_MATCHES_MANY)', () => {
    const db = emptyDb();
    db.c.byPhone.set('8765550100', ['CUST-000001', 'CUST-000002']);
    const r = buildReconciliation(source, plan, db.c, db.v);
    expect(r.customerTiers.get(plan.customers[0].customerNumber)).toBe('NAME_REVIEW');
    expect(r.exceptions.some((e) => e.kind === 'PHONE_MATCHES_MANY')).toBe(true);
  });

  it('vehicles: exact code vs plate/VIN on another record vs create', () => {
    const db = emptyDb();
    const [v1, v2] = plan.vehicles;
    db.v.byVehicleCode.add(v1.vehicleCode);
    db.v.byPlate.set(v2.plateNumber!, ['SCOTHER']);
    const r = buildReconciliation(source, plan, db.c, db.v);
    expect(r.vehicles).toMatchObject({ exactKey: 1, byPlateOrVin: 1, wouldCreate: 1, reconciles: true });
    expect(r.exceptions.some((e) => e.kind === 'PLATE_ON_ANOTHER_VEHICLE' && e.key === v2.vehicleCode)).toBe(true);
  });

  it('the source check fails when parsed + dropped ≠ rows in file (silent loss becomes visible)', () => {
    const db = emptyDb();
    const r = buildReconciliation({ rowsInFile: 10, parsed: 4, droppedShortRows: 1, droppedNoId: 1 }, plan, db.c, db.v);
    expect(r.source.reconciles).toBe(false);
    expect(renderReconciliationMarkdown(r, { sourceFile: 'x.csv', database: 'test', mode: 'RECONCILE' })).toContain('DOES NOT RECONCILE');
  });

  it('markdown and totals carry counts only; the CSV carries the detail', () => {
    const db = emptyDb();
    db.c.byName.set('jane doe', ['CUST-000007']);
    const r = buildReconciliation(source, plan, db.c, db.v);
    const md = renderReconciliationMarkdown(r, { sourceFile: 'customers.csv', database: 'bsop_dev', mode: 'RECONCILE', generatedAt: new Date('2026-09-15T00:00:00Z') });
    expect(md).toContain('| Data rows in file | 5 |');
    expect(md).toContain('✓ reconciles');
    expect(md).not.toContain('Jane Doe'); // no PII in the committed-safe table
    const totals = reconciliationTotals(r);
    expect(totals.exceptions).toBe(r.exceptions.length);
    expect(totals.exceptionKinds.NAME_REVIEW).toBe(1);
    expect(exceptionsCsv(r)).toContain('NAME_REVIEW');
    expect(exceptionsCsv(r)).toContain('Jane Doe');
  });
});
