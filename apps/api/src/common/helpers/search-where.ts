/**
 * CR-2026-106 — ONE where-builder for customer / vehicle search.
 *
 * Consumed by `GET /customers?q=` (pickers), the ADMIN directory (raw SQL),
 * `GET /vehicles?q=` and the global `/search` box, so the same input always
 * finds the same records (docs/121 §C1). Semantics:
 *
 *  - Names: every name token must match first OR last name (case-insensitive,
 *    partial). "Vincent Wilson", "Wilson Vincent", "vincent  wilson" and
 *    "Vin Wil" all find first="Vincent" last="Wilson"; a company or joint owner
 *    stored wholly in lastName ("BROWN, JOHN / MARY") is found by any of its words.
 *  - Phone: when the input reads as a number, match the last 7 digits against the
 *    stored digits (phones are stored digits-only; the SQL side strips as a guard).
 *    A plate such as "1234AB" is NOT a phone, so it never returns phone noise.
 *  - Plate / VIN / vehicle code: separator-insensitive, upper-case.
 *  - Customer number and email: plain partial match.
 *
 * Pure builders — callers add scope (`liveCustomerWhere`, test-data exclusion),
 * ordering and limits.
 */

import { Prisma } from '@prisma/client';
import { parseSearchQuery, type ParsedSearch } from './search-terms';

const ci = (contains: string): Prisma.StringFilter => ({ contains, mode: 'insensitive' });

/**
 * Does the input read as a plate / VIN / code rather than a person's name?
 * Plates and VINs carry digits ("1234 AB", "SC1211KC"); a bare single token may be
 * either ("BROWN" / "ABC"), so it is tried both ways. A multi-word query with no
 * digit ("Vincent Wilson") is a name and never a vehicle identifier.
 */
function looksLikeVehicleId(p: ParsedSearch): boolean {
  return !p.looksLikePhone && p.code.length >= 2 && (/\d/.test(p.code) || p.tokens.length === 1);
}

/** Predicates on the vehicle's own identifiers (plate / VIN / code). Stored plates are stripped + upper-cased. */
export function vehicleIdentityWhere(p: ParsedSearch): Prisma.VehicleWhereInput | null {
  if (!looksLikeVehicleId(p)) return null;
  return {
    OR: [
      { vehicleCode: ci(p.code) },
      { plateNumber: ci(p.code) },
      { vin: ci(p.code) },
    ],
  };
}

/** Predicates on the customer's own fields (names / phone / number / email). */
export function customerIdentityWhere(p: ParsedSearch): Prisma.CustomerWhereInput | null {
  const or: Prisma.CustomerWhereInput[] = [];

  if (p.nameTokens.length > 0 && !p.looksLikePhone) {
    or.push({
      AND: p.nameTokens.map((tok) => ({ OR: [{ firstName: ci(tok) }, { lastName: ci(tok) }] })),
    });
  }
  if (p.looksLikePhone) {
    or.push({ phone: { contains: p.phoneTail } });
  }
  if (p.tokens.length === 1 && !p.looksLikePhone) {
    or.push({ customerNumber: ci(p.raw) });
  }
  if (p.looksLikeEmail || (p.tokens.length === 1 && !p.looksLikePhone)) {
    or.push({ email: ci(p.raw) });
  }
  return or.length ? { OR: or } : null;
}

/** Customer search: the customer's own fields OR one of their vehicles' identifiers (one flat OR). */
export function customerSearchWhere(query: string): Prisma.CustomerWhereInput | null {
  const p = parseSearchQuery(query);
  if (!p.raw) return null;
  const or: Prisma.CustomerWhereInput[] = [];
  const own = customerIdentityWhere(p);
  if (own) or.push(...(own.OR as Prisma.CustomerWhereInput[]));
  const veh = vehicleIdentityWhere(p);
  if (veh) or.push({ vehicles: { some: veh } });
  return or.length ? { OR: or } : null;
}

/** Vehicle search: the vehicle's identifiers OR its owner's own fields. */
export function vehicleSearchWhere(query: string): Prisma.VehicleWhereInput | null {
  const p = parseSearchQuery(query);
  if (!p.raw) return null;
  const or: Prisma.VehicleWhereInput[] = [];
  const veh = vehicleIdentityWhere(p);
  if (veh) or.push(...(veh.OR as Prisma.VehicleWhereInput[]));
  const own = customerIdentityWhere(p);
  if (own) or.push({ customer: own });
  return or.length ? { OR: or } : null;
}

/** Deterministic customer ordering: a surname search returns the same rows every time. */
export const CUSTOMER_SEARCH_ORDER: Prisma.CustomerOrderByWithRelationInput[] = [
  { lastName: 'asc' },
  { firstName: 'asc' },
  { customerNumber: 'asc' },
];

/** Search result cap for pickers (was 20 with no tie-break). */
export const CUSTOMER_SEARCH_TAKE = 50;

/**
 * Same semantics as `customerSearchWhere` for the raw-SQL directory. Alias `c`
 * = customers, vehicles joined as `v`. Returns `Prisma.empty` for a blank query.
 */
export function customerSearchSql(query: string): Prisma.Sql {
  const p = parseSearchQuery(query);
  if (!p.raw) return Prisma.empty;
  const parts: Prisma.Sql[] = [];

  if (p.nameTokens.length > 0 && !p.looksLikePhone) {
    const tokenConds = p.nameTokens.map(
      (tok) => Prisma.sql`(c.first_name ILIKE ${'%' + tok + '%'} OR c.last_name ILIKE ${'%' + tok + '%'})`,
    );
    parts.push(Prisma.sql`(${Prisma.join(tokenConds, ' AND ')})`);
  }
  if (p.looksLikePhone) {
    parts.push(Prisma.sql`regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g') LIKE ${'%' + p.phoneTail + '%'}`);
  }
  if (p.tokens.length === 1 && !p.looksLikePhone) {
    parts.push(Prisma.sql`c.customer_number ILIKE ${'%' + p.raw + '%'}`);
    parts.push(Prisma.sql`c.email ILIKE ${'%' + p.raw + '%'}`);
  } else if (p.looksLikeEmail) {
    parts.push(Prisma.sql`c.email ILIKE ${'%' + p.raw + '%'}`);
  }
  if (!p.looksLikePhone && p.code.length >= 2) {
    const codeLike = '%' + p.code + '%';
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id AND (
      replace(upper(v.vehicle_code), '-', '') LIKE ${codeLike}
      OR upper(regexp_replace(v.plate_number, '[^A-Za-z0-9]', '', 'g')) LIKE ${codeLike}
      OR upper(COALESCE(v.vin,'')) LIKE ${codeLike}
    ))`);
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : Prisma.empty;
}
