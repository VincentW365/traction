import { describe, it, expect } from 'vitest';
import { INITIAL_WIZARD_STATE, canEnter, firstIncompleteStep, wizardReducer, type WizardState } from '../lib/appointment-wizard';

/** CR-2026-106 §C5 — the wizard's reset rules, stated once and tested. */

const cust = (id: string) => ({ id, customerNumber: `C-${id}`, firstName: 'A', lastName: 'B', phone: '8765550000' });
const veh = (id: string) => ({ id, plateNumber: `P${id}`, make: null, model: null, modelYear: null });
const slot = { startAt: '2026-09-17T14:00:00.000Z', endAt: '2026-09-17T15:20:00.000Z', available: true };

function filled(): WizardState {
  let s = wizardReducer(INITIAL_WIZARD_STATE, { type: 'SELECT_CUSTOMER', customer: cust('c1') });
  s = wizardReducer(s, { type: 'CUSTOMER_DETAIL_LOADED', customer: { id: 'c1' }, vehicles: [veh('v1'), veh('v2')] });
  s = wizardReducer(s, { type: 'SELECT_VEHICLE', vehicle: veh('v1') });
  s = wizardReducer(s, { type: 'TOGGLE_SERVICE', code: 'OIL-01' });
  s = wizardReducer(s, { type: 'SET_DATE', dateKey: '2026-09-17' });
  s = wizardReducer(s, { type: 'SELECT_SLOT', slot });
  return s;
}

describe('appointment wizard reducer', () => {
  it('walks customer → vehicle → services → date → time → review', () => {
    const s = filled();
    expect(s.step).toBe('review');
    expect(s.customer?.id).toBe('c1');
    expect(s.vehicle?.id).toBe('v1');
    expect(s.serviceCodes).toEqual(['OIL-01']);
    expect(s.dateKey).toBe('2026-09-17');
    expect(s.slot).toEqual(slot);
  });

  it('choosing a DIFFERENT customer resets vehicle, slot and acknowledgements, keeps services', () => {
    const s = wizardReducer({ ...filled(), acknowledgeCapacity: true }, { type: 'SELECT_CUSTOMER', customer: cust('c2') });
    expect(s.customer?.id).toBe('c2');
    expect(s.vehicle).toBeNull();
    expect(s.customerVehicles).toBeNull();
    expect(s.slot).toBeNull();
    expect(s.acknowledgeCapacity).toBe(false);
    expect(s.serviceCodes).toEqual(['OIL-01']);
    expect(s.step).toBe('vehicle');
  });

  it('re-choosing the SAME customer keeps the vehicle', () => {
    const s = wizardReducer(filled(), { type: 'SELECT_CUSTOMER', customer: cust('c1') });
    expect(s.vehicle?.id).toBe('v1');
  });

  it('changing the vehicle keeps the customer and clears the slot', () => {
    const s = wizardReducer(filled(), { type: 'SELECT_VEHICLE', vehicle: veh('v2') });
    expect(s.customer?.id).toBe('c1');
    expect(s.vehicle?.id).toBe('v2');
    expect(s.slot).toBeNull();
    expect(s.step).toBe('services');
  });

  it('changing services or the date clears the chosen slot', () => {
    expect(wizardReducer(filled(), { type: 'TOGGLE_SERVICE', code: 'BRK-01' }).slot).toBeNull();
    expect(wizardReducer(filled(), { type: 'SET_DATE', dateKey: '2026-09-18' }).slot).toBeNull();
    // Same date again does not throw the slot away.
    expect(wizardReducer(filled(), { type: 'SET_DATE', dateKey: '2026-09-17' }).slot).toEqual(slot);
  });

  it('going BACK is always allowed and never bounces forward; going forward needs inputs', () => {
    const s = filled();
    const back = wizardReducer(s, { type: 'GO_TO', step: 'customer' });
    expect(back.step).toBe('customer');
    expect(back.customer?.id).toBe('c1');
    // Detail reload while on the customer step must NOT auto-advance (the old bug).
    const reloaded = wizardReducer(back, { type: 'CUSTOMER_DETAIL_LOADED', customer: { id: 'c1' }, vehicles: [veh('v1')] });
    expect(reloaded.step).toBe('customer');
    const forward = wizardReducer(INITIAL_WIZARD_STATE, { type: 'GO_TO', step: 'review' });
    expect(forward.step).toBe('customer');
  });

  it('auto-selects a single vehicle only when waiting on the vehicle step', () => {
    let s = wizardReducer(INITIAL_WIZARD_STATE, { type: 'SELECT_CUSTOMER', customer: cust('c1') });
    s = wizardReducer(s, { type: 'CUSTOMER_DETAIL_LOADED', customer: { id: 'c1' }, vehicles: [veh('only')] });
    expect(s.vehicle?.id).toBe('only');
    expect(s.step).toBe('services');
    let two = wizardReducer(INITIAL_WIZARD_STATE, { type: 'SELECT_CUSTOMER', customer: cust('c1') });
    two = wizardReducer(two, { type: 'CUSTOMER_DETAIL_LOADED', customer: { id: 'c1' }, vehicles: [veh('a'), veh('b')] });
    expect(two.vehicle).toBeNull();
    expect(two.step).toBe('vehicle');
  });

  it('honours ?customerId&vehicleId deep links and drops a vehicle that is not theirs', () => {
    let s = wizardReducer(INITIAL_WIZARD_STATE, { type: 'PREFILL', customerId: 'c1', vehicleId: 'v2' });
    expect(s.step).toBe('vehicle');
    s = wizardReducer(s, { type: 'CUSTOMER_DETAIL_LOADED', customer: { id: 'c1', firstName: 'Vin' }, vehicles: [veh('v1'), veh('v2')] });
    expect(s.vehicle?.id).toBe('v2');
    expect(s.customer?.firstName).toBe('Vin');
    expect(s.step).toBe('services');
    let bad = wizardReducer(INITIAL_WIZARD_STATE, { type: 'PREFILL', customerId: 'c1', vehicleId: 'zz' });
    bad = wizardReducer(bad, { type: 'CUSTOMER_DETAIL_LOADED', customer: { id: 'c1' }, vehicles: [veh('v1'), veh('v2')] });
    expect(bad.vehicle).toBeNull();
    expect(bad.step).toBe('vehicle');
  });

  it('canEnter / firstIncompleteStep describe the gating', () => {
    expect(canEnter(INITIAL_WIZARD_STATE, 'vehicle')).toBe(false);
    expect(canEnter(filled(), 'review')).toBe(true);
    expect(firstIncompleteStep(INITIAL_WIZARD_STATE)).toBe('customer');
    expect(firstIncompleteStep({ ...filled(), slot: null })).toBe('time');
  });
});
