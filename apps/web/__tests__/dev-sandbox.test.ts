/**
 * Dev Sandbox Mode helpers (CR-2026-023, E-e).
 *
 * Pure-logic tests, matching the app's existing no-DOM vitest setup (no
 * testing-library / jsdom in this package). Covers the confirmation-phrase
 * gate, short id, disabled-error detection, and the non-zero counts reducer.
 */
import { describe, it, expect } from 'vitest';
import {
  DEV_SANDBOX_CONFIRM,
  shortRunId,
  isConfirmPhraseValid,
  isDisabledError,
  nonZeroCounts,
} from '../lib/dev-sandbox';

describe('isConfirmPhraseValid (strict, mirrors API)', () => {
  it('accepts only the exact phrase', () => {
    expect(isConfirmPhraseValid('CLEAN UP DEV SANDBOX')).toBe(true);
    expect(isConfirmPhraseValid(DEV_SANDBOX_CONFIRM)).toBe(true);
  });
  it('rejects case / spacing / partial variants', () => {
    expect(isConfirmPhraseValid('clean up dev sandbox')).toBe(false);
    expect(isConfirmPhraseValid('CLEAN UP DEV SANDBOX ')).toBe(false); // trailing space
    expect(isConfirmPhraseValid(' CLEAN UP DEV SANDBOX')).toBe(false);
    expect(isConfirmPhraseValid('CLEAN UP')).toBe(false);
    expect(isConfirmPhraseValid('')).toBe(false);
  });
});

describe('shortRunId', () => {
  it('takes the first 8 chars', () => {
    expect(shortRunId('60a1c1d7-e3f2-4160-aeff-2c277a2f66f5')).toBe('60a1c1d7');
  });
  it('is safe for null/undefined/short input', () => {
    expect(shortRunId(null)).toBe('');
    expect(shortRunId(undefined)).toBe('');
    expect(shortRunId('abc')).toBe('abc');
  });
});

describe('isDisabledError', () => {
  it('detects the API disabled refusal (any case)', () => {
    expect(isDisabledError('Dev login is disabled')).toBe(true);
    expect(isDisabledError('DISABLED')).toBe(true);
  });
  it('is false for unrelated errors / empty', () => {
    expect(isDisabledError('No active dev sandbox session')).toBe(false);
    expect(isDisabledError('Network error')).toBe(false);
    expect(isDisabledError(null)).toBe(false);
    expect(isDisabledError(undefined)).toBe(false);
  });
});

describe('nonZeroCounts', () => {
  it('keeps only >0, sorted by count desc then name', () => {
    const counts = { Customer: 1, ExternalSystemRef: 1, ServiceVisit: 0, Appointment: 3, Vehicle: 0 };
    expect(nonZeroCounts(counts)).toEqual([
      ['Appointment', 3],
      ['Customer', 1],
      ['ExternalSystemRef', 1],
    ]);
  });
  it('returns [] for a zero-child / empty session', () => {
    expect(nonZeroCounts({ Customer: 0, Vehicle: 0 })).toEqual([]);
    expect(nonZeroCounts({})).toEqual([]);
    expect(nonZeroCounts(null)).toEqual([]);
  });
});
