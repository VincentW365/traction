import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  PLACEHOLDER_CUSTOMER_NUMBER, PLACEHOLDER_VEHICLE_CODE_PREFIX, HISTORICAL_VISIT_SOURCE_TYPE,
  TEST_CUSTOMER_NAME_PREFIX,
  isHistoricalVisit, isPlaceholderCustomer, isPlaceholderVehicle, isTestDataRow,
  liveVisitWhere, liveCustomerWhere, liveVehicleWhere, serviceVisitIsLive,
  liveVisitSql, liveVisitSqlText, liveVehicleSqlText, liveCustomerSqlText,
  testDataExcludeSqlText,
  historicalVisitWhere, historicalVisitSqlText,
} from '../operational-scope';

describe('operational-scope predicates', () => {
  it('isHistoricalVisit', () => {
    expect(isHistoricalVisit({ sourceType: 'HISTORICAL_IMPORT' })).toBe(true);
    expect(isHistoricalVisit({ sourceType: 'WALKIN' })).toBe(false);
    expect(isHistoricalVisit({})).toBe(false);
  });
  it('isPlaceholderCustomer', () => {
    expect(isPlaceholderCustomer({ customerNumber: PLACEHOLDER_CUSTOMER_NUMBER })).toBe(true);
    expect(isPlaceholderCustomer({ customerNumber: 'CUST-000001' })).toBe(false);
  });
  it('isPlaceholderVehicle (prefix, not substring)', () => {
    expect(isPlaceholderVehicle({ vehicleCode: 'HIST-UNRESOLVED-42' })).toBe(true);
    expect(isPlaceholderVehicle({ vehicleCode: 'SC-6354KM' })).toBe(false);
    expect(isPlaceholderVehicle({ vehicleCode: 'SC-HIST-UNRESOLVED-x' })).toBe(false); // prefix only
  });
  it('isTestDataRow (CR-2026-020)', () => {
    expect(isTestDataRow({ testDataRunId: 'run-1' })).toBe(true);
    expect(isTestDataRow({ testDataRunId: null })).toBe(false);
    expect(isTestDataRow({})).toBe(false); // real & imported rows have no run id
    expect(TEST_CUSTOMER_NAME_PREFIX).toBe('VWTEST');
  });
});

describe('Prisma where-builders default to exclusion, empty when opted in', () => {
  // By default both historical AND test data are excluded. `testDataRunId: null`
  // is a no-op for real/imported rows (they have no run id), so report output is
  // unchanged until a test run exists.
  it('liveVisitWhere', () => {
    expect(liveVisitWhere()).toEqual({ sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE }, testDataRunId: null });
    expect(liveVisitWhere(true)).toEqual({ testDataRunId: null }); // historical in, test still out
    expect(liveVisitWhere(false, true)).toEqual({ sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE } }); // test in
    expect(liveVisitWhere(true, true)).toEqual({}); // both opted in → no-op
    expect(serviceVisitIsLive()).toEqual({ sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE }, testDataRunId: null });
  });
  it('liveCustomerWhere', () => {
    expect(liveCustomerWhere()).toEqual({ customerNumber: { not: PLACEHOLDER_CUSTOMER_NUMBER }, testDataRunId: null });
    expect(liveCustomerWhere(true)).toEqual({ testDataRunId: null });
    expect(liveCustomerWhere(true, true)).toEqual({});
  });
  it('liveVehicleWhere', () => {
    expect(liveVehicleWhere()).toEqual({ vehicleCode: { not: { startsWith: PLACEHOLDER_VEHICLE_CODE_PREFIX } }, testDataRunId: null });
    expect(liveVehicleWhere(true)).toEqual({ testDataRunId: null });
    expect(liveVehicleWhere(true, true)).toEqual({});
  });
});

describe('raw-SQL fragments', () => {
  it('text contains the marker predicate by default', () => {
    expect(liveVisitSqlText('sv')).toBe("AND sv.source_type <> 'HISTORICAL_IMPORT'");
    expect(liveVehicleSqlText('v')).toBe("AND v.vehicle_code NOT LIKE 'HIST-UNRESOLVED-%'");
    expect(liveCustomerSqlText('c')).toBe("AND c.customer_number <> 'BERT-HIST-UNKNOWN'");
  });
  it('testDataExcludeSqlText is the IS NULL predicate (one helper for all 3 aliases)', () => {
    expect(testDataExcludeSqlText('sv')).toBe('AND sv.test_data_run_id IS NULL');
    expect(testDataExcludeSqlText('c')).toBe('AND c.test_data_run_id IS NULL');
    expect(() => testDataExcludeSqlText('a b')).toThrow(/Unsafe SQL alias/);
  });
  it('Sql builder combines historical + test fragments; empty only when fully opted in', () => {
    // default: both fragments present
    expect(liveVisitSql('sv').sql).toContain("source_type <> 'HISTORICAL_IMPORT'");
    expect(liveVisitSql('sv').sql).toContain('test_data_run_id IS NULL');
    // includeHistorical only → test fragment still present (NOT empty)
    expect(liveVisitSql('sv', true)).not.toBe(Prisma.empty);
    expect(liveVisitSql('sv', true).sql).toContain('test_data_run_id IS NULL');
    // both opted in → empty
    expect(liveVisitSql('sv', true, true)).toBe(Prisma.empty);
  });
  it('rejects unsafe (user-controlled) aliases', () => {
    expect(() => liveVisitSqlText('sv; DROP TABLE customers;--')).toThrow(/Unsafe SQL alias/);
    expect(() => liveVisitSqlText('a b')).toThrow(/Unsafe SQL alias/);
  });
});

describe('historical-only helpers (CR-2026-013)', () => {
  it('historicalVisitWhere selects only HISTORICAL_IMPORT', () => {
    expect(historicalVisitWhere()).toEqual({ sourceType: HISTORICAL_VISIT_SOURCE_TYPE });
  });
  it('historicalVisitSqlText is the equality predicate (and rejects unsafe alias)', () => {
    expect(historicalVisitSqlText('sv')).toBe("AND sv.source_type = 'HISTORICAL_IMPORT'");
    expect(() => historicalVisitSqlText('a b')).toThrow(/Unsafe SQL alias/);
  });
});
