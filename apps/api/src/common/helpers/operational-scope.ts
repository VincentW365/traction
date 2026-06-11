/**
 * Operational scope filters (CR-2026-006; test-data exclusion CR-2026-020).
 *
 * Single source of truth for excluding HISTORICAL_IMPORT visits, placeholder
 * customer/vehicle records, AND test-data-sandbox rows from LIVE operational
 * metrics/lists by default, while allowing explicit opt-ins (`includeHistorical`,
 * `includeTestData`) on reporting/lookup surfaces.
 *
 * Pure module (no PrismaService singleton) — unit-testable like common/helpers/mileage-gate.
 * Provides Prisma where-builders AND raw-SQL fragments (reporting is $queryRaw-heavy).
 *
 * Markers (from the historical imports, CR-2026-003/004/005):
 *  - ServiceVisit.sourceType === 'HISTORICAL_IMPORT'
 *  - Customer.customerNumber === 'BERT-HIST-UNKNOWN'
 *  - Vehicle.vehicleCode startsWith 'HIST-UNRESOLVED-'
 *
 * Test-data marker (CR-2026-020):
 *  - Customer/Vehicle/ServiceVisit.testDataRunId IS NOT NULL  (only test rows carry it)
 *  The exclusion is `testDataRunId IS NULL`, which is a NO-OP when no test data
 *  exists (the column is null for every real & imported row) — so adding it does
 *  not change any report output until a test run is actually present.
 */
import { Prisma, VisitSourceType } from '@prisma/client';

export const HISTORICAL_VISIT_SOURCE_TYPE: VisitSourceType = VisitSourceType.HISTORICAL_IMPORT;
export const PLACEHOLDER_CUSTOMER_NUMBER = 'BERT-HIST-UNKNOWN';
export const PLACEHOLDER_VEHICLE_CODE_PREFIX = 'HIST-UNRESOLVED-';
/** Visible name marker for sandbox customers (CR-2026-020); not used for scope filtering. */
export const TEST_CUSTOMER_NAME_PREFIX = 'VWTEST';

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
/** True only for rows created by the test-data sandbox (CR-2026-020). */
export function isTestDataRow(r: { testDataRunId?: string | null }): boolean {
  return r?.testDataRunId != null;
}

// --- Prisma where-builders (return {} when fully opted-in → spread no-op) -----
// Each excludes historical (unless includeHistorical) AND test data (unless
// includeTestData). `testDataRunId: null` is a no-op when no test rows exist.
export function liveVisitWhere(includeHistorical = false, includeTestData = false): Prisma.ServiceVisitWhereInput {
  const where: Prisma.ServiceVisitWhereInput = {};
  if (!includeHistorical) where.sourceType = { not: HISTORICAL_VISIT_SOURCE_TYPE };
  if (!includeTestData) where.testDataRunId = null;
  return where;
}
export function liveCustomerWhere(includeHistorical = false, includeTestData = false): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = {};
  if (!includeHistorical) where.customerNumber = { not: PLACEHOLDER_CUSTOMER_NUMBER };
  if (!includeTestData) where.testDataRunId = null;
  return where;
}
export function liveVehicleWhere(includeHistorical = false, includeTestData = false): Prisma.VehicleWhereInput {
  const where: Prisma.VehicleWhereInput = {};
  if (!includeHistorical) where.vehicleCode = { not: { startsWith: PLACEHOLDER_VEHICLE_CODE_PREFIX } };
  if (!includeTestData) where.testDataRunId = null;
  return where;
}
/** Nested fragment for `serviceVisit: { ... }` relation filters. */
export function serviceVisitIsLive(includeHistorical = false, includeTestData = false): Prisma.ServiceVisitWhereInput {
  return liveVisitWhere(includeHistorical, includeTestData);
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
/**
 * Test-data exclusion fragment (CR-2026-020). The column `test_data_run_id`
 * exists on service_visits, customers, and vehicles — one helper covers all
 * three. `IS NULL` is a no-op until a test run is present.
 */
export function testDataExcludeSqlText(alias: string): string {
  assertAlias(alias);
  return `AND ${alias}.test_data_run_id IS NULL`;
}

function joinSql(parts: string[]): Prisma.Sql {
  return parts.length ? Prisma.raw(parts.join(' ')) : Prisma.empty;
}

export function liveVisitSql(alias: string, includeHistorical = false, includeTestData = false): Prisma.Sql {
  const parts: string[] = [];
  if (!includeHistorical) parts.push(liveVisitSqlText(alias));
  if (!includeTestData) parts.push(testDataExcludeSqlText(alias));
  return joinSql(parts);
}
export function liveVehicleSql(alias: string, includeHistorical = false, includeTestData = false): Prisma.Sql {
  const parts: string[] = [];
  if (!includeHistorical) parts.push(liveVehicleSqlText(alias));
  if (!includeTestData) parts.push(testDataExcludeSqlText(alias));
  return joinSql(parts);
}
export function liveCustomerSql(alias: string, includeHistorical = false, includeTestData = false): Prisma.Sql {
  const parts: string[] = [];
  if (!includeHistorical) parts.push(liveCustomerSqlText(alias));
  if (!includeTestData) parts.push(testDataExcludeSqlText(alias));
  return joinSql(parts);
}

/** HISTORICAL-ONLY raw fragment (CR-2026-013). Alias must be a hard-coded literal. */
export function historicalVisitSqlText(alias: string): string {
  assertAlias(alias);
  return `AND ${alias}.source_type = '${HISTORICAL_VISIT_SOURCE_TYPE}'`;
}
export function historicalVisitSql(alias: string): Prisma.Sql {
  return Prisma.raw(historicalVisitSqlText(alias));
}
