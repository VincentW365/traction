import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { customerSearchWhere, vehicleSearchWhere, customerSearchSql } from '../search-where';

/**
 * CR-2026-106 — the shared where-builder. These assert the SHAPE of the predicate
 * for each input class management listed (docs/121 §C1); the DB-backed
 * integration spec proves the same inputs find real imported rows.
 */

const json = (v: unknown) => JSON.stringify(v);

function nameAnd(where: Prisma.CustomerWhereInput | null): Array<Record<string, unknown>> | undefined {
  const or = (where?.OR ?? []) as Array<Record<string, unknown>>;
  const withAnd = or.find((c) => 'AND' in c);
  return withAnd?.AND as Array<Record<string, unknown>> | undefined;
}

describe('customerSearchWhere — names', () => {
  it('first name only: one token must match first OR last', () => {
    const and = nameAnd(customerSearchWhere('Vincent'))!;
    expect(and).toHaveLength(1);
    expect(json(and[0])).toContain('"firstName":{"contains":"Vincent","mode":"insensitive"}');
    expect(json(and[0])).toContain('"lastName":{"contains":"Vincent","mode":"insensitive"}');
  });

  it('last name only works the same way (no dependency on which column holds it)', () => {
    const and = nameAnd(customerSearchWhere('Wilson'))!;
    expect(and).toHaveLength(1);
  });

  it('full name: EVERY token must match first or last — "Vincent Wilson" finds first=Vincent last=Wilson', () => {
    const and = nameAnd(customerSearchWhere('Vincent Wilson'))!;
    expect(and).toHaveLength(2);
    expect(json(and[0])).toContain('"contains":"Vincent"');
    expect(json(and[1])).toContain('"contains":"Wilson"');
  });

  it('name in either order and with extra spaces / capitals produces the same predicate set', () => {
    const a = nameAnd(customerSearchWhere('Wilson Vincent'))!;
    const b = nameAnd(customerSearchWhere('  wilson   VINCENT '))!;
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(json(b)).toContain('"contains":"wilson"');
    expect(json(b)).toContain('"contains":"VINCENT"');
  });

  it('partial first + last: "Vin Wil" still yields two token predicates', () => {
    expect(nameAnd(customerSearchWhere('Vin Wil'))).toHaveLength(2);
  });

  it('never runs the whole string against a single column (the original defect)', () => {
    expect(json(customerSearchWhere('Vincent Wilson'))).not.toContain('"contains":"Vincent Wilson"');
  });
});

describe('customerSearchWhere — phone', () => {
  it('formatted and unformatted numbers produce the same last-7-digit predicate and no name predicate', () => {
    for (const q of ['876-555-1234', '8765551234', '(876) 555-1234', '+1 876 555 1234']) {
      const where = customerSearchWhere(q)!;
      expect(json(where), q).toContain('"phone":{"contains":"5551234"}');
      expect(nameAnd(where), q).toBeUndefined();
      expect(json(where), q).not.toContain('vehicles');
    }
  });

  it('a plate-shaped query is not treated as a phone', () => {
    expect(json(customerSearchWhere('1234AB'))).not.toContain('"phone"');
  });
});

describe('customerSearchWhere — plate / VIN via the customer\'s vehicles', () => {
  it('"1234AB", "1234 AB" and "1234-AB" all compare the stripped code 1234AB', () => {
    for (const q of ['1234AB', '1234 AB', '1234-AB', '1234ab']) {
      const where = customerSearchWhere(q)!;
      expect(json(where), q).toContain('"vehicleCode":{"contains":"1234AB","mode":"insensitive"}');
      expect(json(where), q).toContain('"plateNumber":{"contains":"1234AB","mode":"insensitive"}');
      expect(json(where), q).toContain('"vin":{"contains":"1234AB","mode":"insensitive"}');
    }
  });

  it('a 1-character query yields no vehicle predicate', () => {
    expect(json(customerSearchWhere('a'))).not.toContain('vehicles');
  });

  it('customer number and email are matched for single-token queries', () => {
    const where = json(customerSearchWhere('CUST-000043'));
    expect(where).toContain('"customerNumber":{"contains":"CUST-000043"');
    expect(where).toContain('"email":{"contains":"CUST-000043"');
    expect(json(customerSearchWhere('jane@example.test'))).toContain('"email":{"contains":"jane@example.test"');
  });

  it('blank query yields null (caller returns no rows without touching the DB)', () => {
    expect(customerSearchWhere('   ')).toBeNull();
  });
});

describe('vehicleSearchWhere', () => {
  it('plate variants and the owner name are both routes to a vehicle', () => {
    const where = vehicleSearchWhere('1234 AB')!;
    const top = where.OR as Array<Record<string, unknown>>;
    expect(top.some((c) => 'plateNumber' in c)).toBe(true);
    expect(top.some((c) => 'vin' in c)).toBe(true);
    expect(top.some((c) => 'vehicleCode' in c)).toBe(true);
    const byOwner = vehicleSearchWhere('Vincent Wilson')!;
    expect(json(byOwner)).toContain('"customer":{"OR":[{"AND"');
  });
});

describe('customerSearchSql (ADMIN directory) — same semantics in SQL', () => {
  const text = (q: string) => customerSearchSql(q).sql;
  const values = (q: string) => customerSearchSql(q).values;

  it('tokenised names → one ILIKE pair per token, AND-joined', () => {
    expect(text('Vincent Wilson')).toMatch(/first_name ILIKE .* OR c\.last_name ILIKE .*\) AND \(c\.first_name ILIKE/);
    expect(values('Vincent Wilson')).toEqual(expect.arrayContaining(['%Vincent%', '%Wilson%']));
  });

  it('phone → digits-only comparison on the stored column', () => {
    expect(text('876-555-1234')).toContain("regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') LIKE");
    expect(values('876-555-1234')).toContain('%5551234%');
  });

  it('plate → EXISTS over vehicles with stripped comparison', () => {
    expect(text('1234 AB')).toContain('EXISTS (SELECT 1 FROM vehicles v');
    expect(values('1234 AB')).toContain('%1234AB%');
  });

  it('blank → empty fragment', () => {
    expect(customerSearchSql('  ')).toBe(Prisma.empty);
  });
});
