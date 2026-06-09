import { describe, it, expect } from 'vitest';
import {
  parseName,
  normalizePhone,
  normalizePlate,
  isJunkPlate,
  normalizeVin,
  parseYear,
  dedupeKey,
  customerNumberFromKey,
  vehicleCode,
  planImport,
  trimOrNull,
  normalizeFuel,
  normalizeTransmission,
  normalizeDrivetrain,
  buildDryRunReport,
  type RawContactRow,
} from '../customer-vehicle.mapper';

// All fixtures synthetic — no real PII.
function row(p: Partial<RawContactRow> & { id: string }): RawContactRow {
  return {
    id: p.id, title: p.title ?? `C-${p.id}`, name: p.name ?? 'JANE DOE',
    phone: p.phone ?? '8765551234', year: p.year ?? '2015', make: p.make ?? 'Toyota',
    model: p.model ?? 'Corolla', plate: p.plate ?? `ABC${p.id}`, chassis: p.chassis ?? `VIN${p.id}0000`,
    email: p.email ?? '', loyalty: p.loyalty ?? '',
    fuel: p.fuel ?? '', transmission: p.transmission ?? '', drivetrain: p.drivetrain ?? '', engineNo: p.engineNo ?? '',
  };
}

describe('normalization helpers', () => {
  it('phone keeps digits only', () => expect(normalizePhone('876-555-1234')).toBe('8765551234'));
  it('plate uppercases + strips', () => expect(normalizePlate('6354 km')).toBe('6354KM'));
  it('junk plate detection', () => {
    expect(isJunkPlate('0')).toBe(true);
    expect(isJunkPlate('N/A')).toBe(true);
    expect(isJunkPlate('6354KM')).toBe(false);
  });
  it('vin normalizes, junk → empty', () => {
    expect(normalizeVin('jt-123 456')).toBe('JT123456');
    expect(normalizeVin('0')).toBe('');
  });
  it('parseYear extracts a 4-digit year', () => {
    expect(parseYear('2016')).toBe(2016);
    expect(parseYear('n/a')).toBeNull();
  });
});

describe('parseName', () => {
  it('LAST, FIRST', () => expect(parseName('SMITH, JOHN')).toEqual({ firstName: 'JOHN', lastName: 'SMITH' }));
  it('FIRST LAST', () => expect(parseName('John Smith')).toEqual({ firstName: 'John', lastName: 'Smith' }));
  it('single token → lastName', () => expect(parseName('Madonna')).toEqual({ firstName: '', lastName: 'Madonna' }));
  it('company kept whole', () => expect(parseName('ND Dispatch Services Ltd')).toEqual({ firstName: '', lastName: 'ND Dispatch Services Ltd' }));
  it('joint owners kept whole', () => expect(parseName('ALLISON / HUGH')).toEqual({ firstName: '', lastName: 'ALLISON / HUGH' }));
  it('empty', () => expect(parseName('')).toEqual({ firstName: '', lastName: '' }));
});

describe('dedupe + deterministic keys', () => {
  it('same name+phone → same key & customerNumber (stable)', () => {
    const k1 = dedupeKey('John Smith', '876-555-1234', '1');
    const k2 = dedupeKey('JOHN SMITH', '8765551234', '2');
    expect(k1).toBe(k2);
    expect(customerNumberFromKey(k1)).toBe(customerNumberFromKey(k2));
  });
  it('blank name → row-unique key (no merge of anonymous rows)', () => {
    expect(dedupeKey('', '8765551234', '9')).toBe('__row_9');
  });
  it('vehicleCode uses plate, falls back to contactId when junk/missing', () => {
    expect(vehicleCode('6354 KM', '5')).toBe('SC-6354KM');
    expect(vehicleCode('0', '5')).toBe('SC-CONTACT-5');
  });
});

describe('planImport', () => {
  it('merges same name+phone into one customer with multiple vehicles', () => {
    const plan = planImport([
      row({ id: '1', name: 'John Smith', phone: '8765551234', plate: 'AAA111' }),
      row({ id: '2', name: 'JOHN SMITH', phone: '876-555-1234', plate: 'BBB222' }),
    ]);
    expect(plan.counts.customersToCreate).toBe(1);
    expect(plan.counts.customerMerges).toBe(1);
    expect(plan.customers[0].vehicleContactIds).toEqual(['1', '2']);
    expect(plan.counts.vehiclesToCreate).toBe(2);
  });

  it('different phone → separate customers', () => {
    const plan = planImport([
      row({ id: '1', name: 'John Smith', phone: '8765551234' }),
      row({ id: '2', name: 'John Smith', phone: '8765559999' }),
    ]);
    expect(plan.counts.customersToCreate).toBe(2);
  });

  it('missing name → flag + placeholder lastName + no merge', () => {
    const plan = planImport([
      row({ id: '7', name: '', phone: '8765551234' }),
      row({ id: '8', name: '', phone: '8765551234' }),
    ]);
    expect(plan.counts.customersToCreate).toBe(2); // anonymous rows not merged
    expect(plan.counts.missingName).toBe(2);
    expect(plan.customers[0].lastName).toBe('Contact 7');
  });

  it('junk plate → JUNK_PLATE flag + contactId-based vehicleCode', () => {
    const plan = planImport([row({ id: '5', plate: '0' })]);
    expect(plan.vehicles[0].flags).toContain('JUNK_PLATE');
    expect(plan.vehicles[0].vehicleCode).toBe('SC-CONTACT-5');
    expect(plan.vehicles[0].plateNumber).toBeNull();
  });

  it('duplicate plate → still its own vehicle with a disambiguated unique code, flagged', () => {
    const plan = planImport([
      row({ id: '1', plate: 'DUP123', chassis: 'VINA111111' }),
      row({ id: '2', plate: 'dup 123', chassis: 'VINB222222' }),
    ]);
    const v1 = plan.vehicles.find((v) => v.contactId === '1')!;
    const v2 = plan.vehicles.find((v) => v.contactId === '2')!;
    expect(plan.counts.vehiclesToCreate).toBe(2);
    expect(v1.vehicleCode).toBe('SC-DUP123');
    expect(v2.vehicleCode).toBe('SC-DUP123-2'); // unique, disambiguated
    expect(v2.plateNumber).toBe('DUP123'); // shared plate value retained (non-unique)
    expect(v2.flags).toContain('DUPLICATE_PLATE');
    expect(plan.counts.duplicatePlates).toBe(1);
  });

  it('duplicate VIN → second vin nulled + flagged (unique constraint safe)', () => {
    const plan = planImport([
      row({ id: '1', plate: 'P1AAAA', chassis: 'SAMEVIN123' }),
      row({ id: '2', plate: 'P2BBBB', chassis: 'same vin 123' }),
    ]);
    const v2 = plan.vehicles.find((v) => v.contactId === '2')!;
    expect(v2.vin).toBeNull();
    expect(v2.flags).toContain('DUPLICATE_VIN');
  });

  it('placeholder phone merge is flagged suspicious', () => {
    const plan = planImport([
      row({ id: '1', name: 'ACME', phone: '876-000-0000', plate: 'X1AAAA' }),
      row({ id: '2', name: 'ACME', phone: '8760000000', plate: 'X2BBBB' }),
    ]);
    expect(plan.counts.suspiciousMerges).toBe(1);
    expect(plan.customers[0].suspiciousMerge).toBe(true);
  });

  it('is deterministic — same input yields identical customerNumbers (idempotency)', () => {
    const input = [row({ id: '1' }), row({ id: '2', name: 'Other Person', phone: '8761112222' })];
    const a = planImport(input);
    const b = planImport(input);
    expect(a.customers.map((c) => c.customerNumber)).toEqual(b.customers.map((c) => c.customerNumber));
    expect(a.vehicles.map((v) => v.vehicleCode)).toEqual(b.vehicles.map((v) => v.vehicleCode));
  });
});

// --- CR-2026-004: additive contact fields + backfill ---
describe('CR-2026-004 field normalizers', () => {
  it('fuel maps synonyms, preserves unknown, null when empty', () => {
    expect(normalizeFuel('gas')).toBe('PETROL');
    expect(normalizeFuel('Diesel')).toBe('DIESEL');
    expect(normalizeFuel('Kerosene')).toBe('Kerosene'); // unknown → source preserved
    expect(normalizeFuel('')).toBeNull();
  });
  it('transmission canonicalizes, preserves unknown', () => {
    expect(normalizeTransmission('auto')).toBe('AUTOMATIC');
    expect(normalizeTransmission('M/T')).toBe('MANUAL');
    expect(normalizeTransmission('Tiptronic')).toBe('Tiptronic');
  });
  it('drivetrain canonicalizes (4x4→4WD), preserves unknown', () => {
    expect(normalizeDrivetrain('4x4')).toBe('4WD');
    expect(normalizeDrivetrain('fwd')).toBe('FWD');
    expect(normalizeDrivetrain('Quattro')).toBe('Quattro');
  });
  it('trimOrNull trims, preserves verbatim, null when empty (loyalty/engine)', () => {
    expect(trimOrNull('  AbC-12 ')).toBe('AbC-12'); // case + inner content preserved
    expect(trimOrNull('   ')).toBeNull();
  });
});

describe('CR-2026-004 backfill mapping + idempotency + engine-no safety', () => {
  it('planImport populates the new vehicle fields + customer loyalty (verbatim engine)', () => {
    const plan = planImport([
      row({ id: '1', loyalty: 'LOY-9', fuel: 'gas', transmission: 'auto', drivetrain: '4x4', engineNo: 'EngAbc 001' }),
    ]);
    expect(plan.customers[0].loyaltyNumber).toBe('LOY-9');
    const v = plan.vehicles[0];
    expect(v.fuelType).toBe('PETROL');
    expect(v.transmission).toBe('AUTOMATIC');
    expect(v.drivetrain).toBe('4WD');
    expect(v.engineNo).toBe('EngAbc 001'); // preserved verbatim
  });

  it('is idempotent — new field values are identical across runs', () => {
    const input = [row({ id: '1', loyalty: 'L1', fuel: 'diesel', engineNo: 'E1' })];
    const a = planImport(input), b = planImport(input);
    expect(a.vehicles[0]).toEqual(b.vehicles[0]);
    expect(a.customers[0].loyaltyNumber).toBe(b.customers[0].loyaltyNumber);
  });

  it('engine number NEVER appears in the dry-run report or flagged CSV', () => {
    const SECRET = 'ENGINE-SECRET-XYZ-999';
    // give the row a flag too (missing plate) so it reaches the flagged CSV path
    const plan = planImport([row({ id: '1', plate: '', engineNo: SECRET })]);
    const { summary, flaggedCsv } = buildDryRunReport(plan, 'customers.csv');
    expect(summary).not.toContain(SECRET);
    expect(flaggedCsv).not.toContain(SECRET);
    expect(summary).toContain('engine_no (values redacted)'); // coverage shown as count only
  });
});
