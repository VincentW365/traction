/**
 * Operational scope filters (CR-2026-006).
 *
 * Single source of truth for excluding HISTORICAL_IMPORT visits and placeholder
 * customer/vehicle records from LIVE operational metrics/lists by default, while
 * allowing an explicit opt-in (`includeHistorical`) on reporting/lookup surfaces.
 *
 * Pure module (no PrismaService singleton) — unit-testable like common/helpers/mileage-gate.
 * Provides Prisma where-builders AND raw-SQL fragments (reporting is $queryRaw-heavy).
 *
 * Markers (from the historical imports, CR-2026-003/004/005):
 *  - ServiceVisit.sourceType === 'HISTORICAL_IMPORT'
 *  - Customer.customerNumber === 'BERT-HIST-UNKNOWN'
 *  - Vehicle.vehicleCode startsWith 'HIST-UNRESOLVED-'
 */
import { Prisma, VisitSourceType } from '@prisma/client';

export const HISTORICAL_VISIT_SOURCE_TYPE: VisitSourceType = VisitSourceType.HISTORICAL_IMPORT;
export const PLACEHOLDER_CUSTOMER_NUMBER = 'BERT-HIST-UNKNOWN';
export const PLACEHOLDER_VEHICLE_CODE_PREFIX = 'HIST-UNRESOLVED-';

// --- Pure predicates (in-memory / tests) -----------------------------------
export function isHistoricalVisit(v: { sourceType?: string | null }): boolean {
  return v?.sourceType === HISTORICAL_VISIT_SOURCE_TYPE;
}
export function isPlaceholderCustomer(c: { customerNumber?: string | null }): boolean {
  return c?.customerNumber === PLACEHOLDER_CUSTOMER_NUMBER;
}
export function isPlaceholderVehicle(v: { vehicleCode?: string | null }): boolean {
  return typeof v?.vehicleCode === 'string' && v.vehicleCode.startsWith(PLACEHOLDER_VEHICLE_CODE_PREFIX);
}

// --- Prisma where-builders (return {} when includeHistorical → spread no-op) -
export function liveVisitWhere(includeHistorical = false): Prisma.ServiceVisitWhereInput {
  return includeHistorical ? {} : { sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE } };
}
export function liveCustomerWhere(includeHistorical = false): Prisma.CustomerWhereInput {
  return includeHistorical ? {} : { customerNumber: { not: PLACEHOLDER_CUSTOMER_NUMBER } };
}
export function liveVehicleWhere(includeHistorical = false): Prisma.VehicleWhereInput {
  return includeHistorical ? {} : { vehicleCode: { not: { startsWith: PLACEHOLDER_VEHICLE_CODE_PREFIX } } };
}
/** Nested fragment for `serviceVisit: { ... }` relation filters. */
export function serviceVisitIsLive(includeHistorical = false): Prisma.ServiceVisitWhereInput {
  return liveVisitWhere(includeHistorical);
}

// --- Inverse: HISTORICAL-ONLY (CR-2026-013 historical analytics) -------------
// Selects ONLY the imported historical visits. Reuses the same marker constant.
export function historicalVisitWhere(): Prisma.ServiceVisitWhereInput {
  return { sourceType: HISTORICAL_VISIT_SOURCE_TYPE };
}

// --- Raw-SQL fragments -------------------------------------------------------
// Aliases MUST be hard-coded literals at the call site (never user input).
function assertAlias(alias: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Unsafe SQL alias: ${alias}`);
  }
}

/** Raw text of the live-visit predicate (pure string — testable). */
export function liveVisitSqlText(alias: string): string {
  assertAlias(alias);
  return `AND ${alias}.source_type <> '${HISTORICAL_VISIT_SOURCE_TYPE}'`;
}
export function liveVehicleSqlText(alias: string): string {
  assertAlias(alias);
  return `AND ${alias}.vehicle_code NOT LIKE '${PLACEHOLDER_VEHICLE_CODE_PREFIX}%'`;
}
export function liveCustomerSqlText(alias: string): string {
  assertAlias(alias);
  return `AND ${alias}.customer_number <> '${PLACEHOLDER_CUSTOMER_NUMBER}'`;
}

export function liveVisitSql(alias: string, includeHistorical = false): Prisma.Sql {
  return includeHistorical ? Prisma.empty : Prisma.raw(liveVisitSqlText(alias));
}
export function liveVehicleSql(alias: string, includeHistorical = false): Prisma.Sql {
  return includeHistorical ? Prisma.empty : Prisma.raw(liveVehicleSqlText(alias));
}
export function liveCustomerSql(alias: string, includeHistorical = false): Prisma.Sql {
  return includeHistorical ? Prisma.empty : Prisma.raw(liveCustomerSqlText(alias));
}

/** HISTORICAL-ONLY raw fragment (CR-2026-013). Alias must be a hard-coded literal. */
export function historicalVisitSqlText(alias: string): string {
  assertAlias(alias);
  return `AND ${alias}.source_type = '${HISTORICAL_VISIT_SOURCE_TYPE}'`;
}
export function historicalVisitSql(alias: string): Prisma.Sql {
  return Prisma.raw(historicalVisitSqlText(alias));
}
