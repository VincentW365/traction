import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { CustomersService } from '../customers.service';
import { VehiclesService } from '../../vehicles/vehicles.service';
import { SearchService } from '../../visits/search.service';
import { normalizePhone } from '../../../common/helpers/search-terms';

/**
 * CR-2026-106 — search against REAL imported (production-style) records.
 *
 * Runs only when RUN_DB_TESTS=1 and DATABASE_URL points at a database that has
 * the SharePoint import (the unit specs cover predicate shape everywhere else).
 * Picks a real imported customer with both names, a 10-digit phone and a plated
 * vehicle, then asserts that every input class management listed finds them:
 * first name, last name, full name, partial full name, reversed order, mixed
 * capitalisation, extra spaces, formatted / unformatted phone, formatted /
 * unformatted plate; plus a no-match case and a multi-match surname.
 *
 *   RUN_DB_TESTS=1 pnpm --filter @bsop/api exec vitest run search.integration
 */

const enabled = process.env.RUN_DB_TESTS === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!enabled)('search against imported records (DB)', () => {
  const prisma = new PrismaClient();
  const customers = new CustomersService(prisma as never);
  const vehicles = new VehiclesService(prisma as never, {} as never);
  const global = new SearchService(prisma as never);

  let subject: { id: string; firstName: string; lastName: string; phone: string; plate: string };

  beforeAll(async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string; first_name: string; last_name: string; phone: string; plate_number: string }>>`
      SELECT c.id, c.first_name, c.last_name, c.phone, v.plate_number
      FROM customers c JOIN vehicles v ON v.customer_id = c.id
      WHERE c.customer_number LIKE 'BERT-C-%'
        AND c.first_name ~ '^[A-Za-z]{3,}$' AND c.last_name ~ '^[A-Za-z]{3,}$'
        AND c.phone ~ '^[0-9]{10}$'
        AND v.plate_number ~ '^[0-9]{4}[A-Z]{2}$'
      ORDER BY c.created_at ASC LIMIT 1`;
    expect(rows.length, 'an imported customer with names/phone/plate must exist').toBe(1);
    subject = { id: rows[0].id, firstName: rows[0].first_name, lastName: rows[0].last_name, phone: rows[0].phone, plate: rows[0].plate_number };
  });

  afterAll(async () => prisma.$disconnect());

  const findsSubject = async (q: string) => {
    const res = await customers.search(q);
    return res.some((r) => r.id === subject.id);
  };

  it('first name / last name / full name / partial / reversed / capitals / spaces', async () => {
    const f = subject.firstName;
    const l = subject.lastName;
    for (const q of [
      f,
      l,
      `${f} ${l}`,
      `${f.slice(0, 3)} ${l.slice(0, 3)}`,
      `${l} ${f}`,
      `${f.toLowerCase()} ${l.toUpperCase()}`,
      `  ${f}   ${l}  `,
    ]) {
      expect(await findsSubject(q), q).toBe(true);
    }
  });

  it('phone with and without formatting', async () => {
    const d = subject.phone; // 10 digits stored
    const dashed = `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    const paren = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    const intl = `+1 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
    for (const q of [d, dashed, paren, intl]) {
      expect(await findsSubject(q), q).toBe(true);
    }
  });

  it('plate with and without formatting, via customers, vehicles and the global box', async () => {
    const p = subject.plate; // e.g. 1234AB stored
    const spaced = `${p.slice(0, 4)} ${p.slice(4)}`;
    const dashed = `${p.slice(0, 4)}-${p.slice(4)}`;
    for (const q of [p, spaced, dashed, p.toLowerCase()]) {
      expect(await findsSubject(q), `customers ${q}`).toBe(true);
      const v = await vehicles.search(q);
      expect(v.some((x) => x.customerId === subject.id), `vehicles ${q}`).toBe(true);
      const g = await global.search(q);
      expect(g.vehicles.some((x) => x.owner?.id === subject.id), `global ${q}`).toBe(true);
    }
  });

  it('global search finds the customer by full name in either order, and the same customer is listed once', async () => {
    for (const q of [`${subject.firstName} ${subject.lastName}`, `${subject.lastName} ${subject.firstName}`]) {
      const g = await global.search(q);
      const hits = g.customers.filter((c) => c.id === subject.id);
      expect(hits.length, q).toBe(1);
    }
  });

  it('no-match returns an empty list, not an error', async () => {
    expect(await customers.search('zzqx-no-such-customer-991')).toEqual([]);
    expect((await global.search('zzqx-no-such-customer-991')).customers).toEqual([]);
  });

  it('a surname shared by many customers returns a deterministic, ordered set', async () => {
    const top = await prisma.$queryRaw<Array<{ last_name: string; n: number }>>`
      SELECT last_name, count(*)::int AS n FROM customers WHERE customer_number LIKE 'BERT-C-%' AND first_name <> ''
      GROUP BY last_name HAVING count(*) > 1 ORDER BY n DESC LIMIT 1`;
    const surname = top[0].last_name;
    const a = await customers.search(surname);
    const b = await customers.search(surname);
    expect(a.length).toBeGreaterThan(1);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a.every((r) => normalizePhone(r.customerNumber) !== undefined)).toBe(true);
  });
});
