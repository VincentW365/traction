import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  PLACEHOLDER_CUSTOMER_NUMBER, PLACEHOLDER_VEHICLE_CODE_PREFIX, HISTORICAL_VISIT_SOURCE_TYPE,
  isHistoricalVisit, isPlaceholderCustomer, isPlaceholderVehicle,
  liveVisitWhere, liveCustomerWhere, liveVehicleWhere, serviceVisitIsLive,
  liveVisitSql, liveVisitSqlText, liveVehicleSqlText, liveCustomerSqlText,
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
});

describe('Prisma where-builders default to exclusion, empty when opted in', () => {
  it('liveVisitWhere', () => {
    expect(liveVisitWhere()).toEqual({ sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE } });
    expect(liveVisitWhere(true)).toEqual({});
    expect(serviceVisitIsLive()).toEqual({ sourceType: { not: HISTORICAL_VISIT_SOURCE_TYPE } });
  });
  it('liveCustomerWhere', () => {
    expect(liveCustomerWhere()).toEqual({ customerNumber: { not: PLACEHOLDER_CUSTOMER_NUMBER } });
    expect(liveCustomerWhere(true)).toEqual({});
  });
  it('liveVehicleWhere', () => {
    expect(liveVehicleWhere()).toEqual({ vehicleCode: { not: { startsWith: PLACEHOLDER_VEHICLE_CODE_PREFIX } } });
    expect(liveVehicleWhere(true)).toEqual({});
  });
});

describe('raw-SQL fragments', () => {
  it('text contains the marker predicate by default', () => {
    expect(liveVisitSqlText('sv')).toBe("AND sv.source_type <> 'HISTORICAL_IMPORT'");
    expect(liveVehicleSqlText('v')).toBe("AND v.vehicle_code NOT LIKE 'HIST-UNRESOLVED-%'");
    expect(liveCustomerSqlText('c')).toBe("AND c.customer_number <> 'BERT-HIST-UNKNOWN'");
  });
  it('Sql builder is empty when opted in, non-empty by default', () => {
    expect(liveVisitSql('sv', true)).toBe(Prisma.empty);
    expect(liveVisitSql('sv', false)).not.toBe(Prisma.empty);
  });
  it('rejects unsafe (user-controlled) aliases', () => {
    expect(() => liveVisitSqlText('sv; DROP TABLE customers;--')).toThrow(/Unsafe SQL alias/);
    expect(() => liveVisitSqlText('a b')).toThrow(/Unsafe SQL alias/);
  });
});
