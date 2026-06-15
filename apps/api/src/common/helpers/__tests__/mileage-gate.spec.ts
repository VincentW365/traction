import { describe, it, expect } from 'vitest';
import { assertMileageGate } from '../mileage-gate';

/** DMAIC Rule 5 — mileage gate (pure function). */
describe('assertMileageGate', () => {
  it('allows a service job WITH mileage', () => {
    expect(() => assertMileageGate({ requiresMileage: true, mileageProvided: true })).not.toThrow();
  });

  it('rejects a service job WITHOUT mileage', () => {
    expect(() => assertMileageGate({ requiresMileage: true, mileageProvided: false })).toThrow(/required/i);
  });

  it('allows a non-service job WITHOUT mileage', () => {
    expect(() => assertMileageGate({ requiresMileage: false, mileageProvided: false })).not.toThrow();
  });

  it('allows a non-service job WITH mileage (CR-2026-037 — mileage decoupled from service)', () => {
    expect(() => assertMileageGate({ requiresMileage: false, mileageProvided: true })).not.toThrow();
  });

  it('manager override bypasses the mileage-required gate', () => {
    expect(() => assertMileageGate({ requiresMileage: true, mileageProvided: false, override: true })).not.toThrow();
    expect(() => assertMileageGate({ requiresMileage: false, mileageProvided: true, override: true })).not.toThrow();
  });
});
