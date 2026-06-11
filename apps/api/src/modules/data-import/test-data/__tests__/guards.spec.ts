import { describe, it, expect } from 'vitest';
import {
  assertTestDataToolsEnabled,
  assertValidLabel,
  assertLabelAvailable,
  formatTestCustomerNumber,
  assertCustomerNumberSafe,
  TEST_CUSTOMER_FIRST_NAME,
} from '../guards';

describe('test-data guards (CR-2026-020)', () => {
  it('env gate refuses unless ALLOW_TEST_DATA_TOOLS is true', () => {
    expect(() => assertTestDataToolsEnabled(false)).toThrow(/disabled/i);
    expect(() => assertTestDataToolsEnabled(undefined as unknown as boolean)).toThrow(/disabled/i);
    expect(() => assertTestDataToolsEnabled(true)).not.toThrow();
  });

  it('label must be a 3–60 char slug', () => {
    expect(() => assertValidLabel('vw-test-run-2026-06-11')).not.toThrow();
    expect(() => assertValidLabel('abc')).not.toThrow();
    expect(() => assertValidLabel(undefined)).toThrow(/Invalid --label/);
    expect(() => assertValidLabel('ab')).toThrow(/Invalid --label/); // too short
    expect(() => assertValidLabel('has space')).toThrow(/Invalid --label/);
    expect(() => assertValidLabel('drop;table')).toThrow(/Invalid --label/);
  });

  it('duplicate label is refused', () => {
    expect(() => assertLabelAvailable(null, 'lbl')).not.toThrow();
    expect(() => assertLabelAvailable({ id: 'run-1' }, 'lbl')).toThrow(/already exists/);
  });

  it('test customers use CUST- numbers only (never VWTEST-)', () => {
    expect(formatTestCustomerNumber(1)).toBe('CUST-000001');
    expect(formatTestCustomerNumber(123456)).toBe('CUST-123456');
    expect(() => assertCustomerNumberSafe('CUST-000001')).not.toThrow();
    expect(() => assertCustomerNumberSafe('VWTEST-001')).toThrow(/not in CUST-/);
    expect(() => assertCustomerNumberSafe('C-1wwgj4vz8flt0')).toThrow(/not in CUST-/);
    expect(formatTestCustomerNumber(1).startsWith('VWTEST')).toBe(false);
  });

  it('the visible marker is the customer NAME prefix', () => {
    expect(TEST_CUSTOMER_FIRST_NAME).toBe('VWTEST');
  });
});
