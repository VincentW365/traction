import { describe, it, expect } from 'vitest';
import {
  isResourceCompatible,
  isResourceAvailableForDispatch,
  findAvailableResources,
  MOBILE_JACK_NON_SEDAN_REASON,
  ResourceState,
  JobRequirements,
} from '../engine/resource-compatibility.checker';

function makeResource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    resourceId: 'res-1',
    code: 'BAY-01',
    resourceCategory: 'BAY',
    maxVehicleWeight: 'HEAVY',
    liftType: 'heavy',
    hasAlignment: false,
    hasDiagnostics: false,
    requiresMechanic: true,
    isOccupied: false,
    hasImminentReservation: false,
    reservedForAppointmentId: null,
    isOperational: true,
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobRequirements> = {}): JobRequirements {
  return {
    vehicleWeightClass: 'STANDARD',
    vehicleServiceClass: 'SEDAN_CLASS',
    requiresAlignment: false,
    requiresDiagnostics: false,
    requiredLiftType: null,
    canUseOverflow: false,
    canUseLightSlot: false,
    appointmentId: null,
    requiresPowerWash: false,
    isExternal: false,
    mobileJackAllowed: true,
    standPreferred: false,
    ...overrides,
  };
}

describe('isResourceCompatible', () => {
  // Weight class matrix
  it('heavy lift accepts HEAVY vehicle', () => {
    const r = makeResource({ maxVehicleWeight: 'HEAVY' });
    const j = makeJob({ vehicleWeightClass: 'HEAVY' });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  it('heavy lift accepts LIGHT vehicle', () => {
    const r = makeResource({ maxVehicleWeight: 'HEAVY' });
    const j = makeJob({ vehicleWeightClass: 'LIGHT' });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  it('sedan lift rejects HEAVY vehicle', () => {
    const r = makeResource({ maxVehicleWeight: 'STANDARD' });
    const j = makeJob({ vehicleWeightClass: 'HEAVY' });
    const result = isResourceCompatible(r, j);
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('exceeds');
  });

  it('power jack (LIGHT) rejects STANDARD vehicle', () => {
    const r = makeResource({ maxVehicleWeight: 'LIGHT' });
    const j = makeJob({ vehicleWeightClass: 'STANDARD' });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
  });

  it('power jack (LIGHT) accepts LIGHT vehicle', () => {
    const r = makeResource({ maxVehicleWeight: 'LIGHT' });
    const j = makeJob({ vehicleWeightClass: 'LIGHT' });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  it('null maxVehicleWeight accepts any vehicle', () => {
    const r = makeResource({ maxVehicleWeight: null });
    const j = makeJob({ vehicleWeightClass: 'HEAVY' });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  // Category checks
  it('overflow rejects job that cannot use overflow', () => {
    const r = makeResource({ resourceCategory: 'OVERFLOW' });
    const j = makeJob({ canUseOverflow: false });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
  });

  it('overflow accepts job that can use overflow', () => {
    const r = makeResource({ resourceCategory: 'OVERFLOW', maxVehicleWeight: 'STANDARD' });
    const j = makeJob({ canUseOverflow: true });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  it('light slot rejects job that cannot use light slot', () => {
    const r = makeResource({ resourceCategory: 'LIGHT_SLOT', maxVehicleWeight: 'LIGHT' });
    const j = makeJob({ canUseLightSlot: false, vehicleWeightClass: 'LIGHT' });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
  });

  it('light slot accepts eligible job', () => {
    const r = makeResource({ resourceCategory: 'LIGHT_SLOT', maxVehicleWeight: 'LIGHT' });
    const j = makeJob({ canUseLightSlot: true, vehicleWeightClass: 'LIGHT' });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  // Capability checks
  it('rejects when alignment required but not available', () => {
    const r = makeResource({ hasAlignment: false });
    const j = makeJob({ requiresAlignment: true });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
  });

  it('accepts when alignment required and available', () => {
    const r = makeResource({ hasAlignment: true });
    const j = makeJob({ requiresAlignment: true });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  it('rejects when diagnostics required but not available', () => {
    const r = makeResource({ hasDiagnostics: false });
    const j = makeJob({ requiresDiagnostics: true });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
  });

  // Lift type checks
  it('rejects when specific lift type required but not matched', () => {
    const r = makeResource({ liftType: 'sedan' });
    const j = makeJob({ requiredLiftType: 'heavy' });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
  });

  it('accepts when required lift type matches', () => {
    const r = makeResource({ liftType: 'heavy' });
    const j = makeJob({ requiredLiftType: 'heavy' });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  it('accepts when no specific lift type required', () => {
    const r = makeResource({ liftType: 'sedan' });
    const j = makeJob({ requiredLiftType: null });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });
});

describe('isResourceAvailableForDispatch', () => {
  it('rejects occupied resource', () => {
    const r = makeResource({ isOccupied: true });
    const j = makeJob();
    const result = isResourceAvailableForDispatch(r, j);
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('occupied');
  });

  it('rejects resource reserved for another appointment', () => {
    const r = makeResource({
      hasImminentReservation: true,
      reservedForAppointmentId: 'appt-other',
    });
    const j = makeJob({ appointmentId: 'appt-mine' });
    const result = isResourceAvailableForDispatch(r, j);
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('reserved');
  });

  it('accepts resource reserved for THIS appointment', () => {
    const r = makeResource({
      hasImminentReservation: true,
      reservedForAppointmentId: 'appt-mine',
    });
    const j = makeJob({ appointmentId: 'appt-mine' });
    expect(isResourceAvailableForDispatch(r, j).compatible).toBe(true);
  });

  it('accepts free compatible resource', () => {
    const r = makeResource();
    const j = makeJob();
    expect(isResourceAvailableForDispatch(r, j).compatible).toBe(true);
  });
});

describe('findAvailableResources', () => {
  it('returns only compatible free resources', () => {
    const resources: ResourceState[] = [
      makeResource({ resourceId: 'r1', maxVehicleWeight: 'HEAVY', isOccupied: false }),
      makeResource({ resourceId: 'r2', maxVehicleWeight: 'LIGHT', isOccupied: false }),
      makeResource({ resourceId: 'r3', maxVehicleWeight: 'HEAVY', isOccupied: true }),
    ];
    const job = makeJob({ vehicleWeightClass: 'STANDARD' });
    const result = findAvailableResources(resources, job);
    expect(result).toEqual(['r1']); // r2 can't handle STANDARD, r3 is occupied
  });

  it('returns empty array when nothing available', () => {
    const resources: ResourceState[] = [
      makeResource({ resourceId: 'r1', isOccupied: true }),
    ];
    const result = findAvailableResources(resources, makeJob());
    expect(result).toEqual([]);
  });
});

// --- DMAIC-alignment tests ---

describe('DMAIC: mobile jack sedan restriction', () => {
  it('mobile jack rejects HEAVY vehicle', () => {
    const r = makeResource({ liftType: 'mobile', maxVehicleWeight: 'STANDARD' });
    const j = makeJob({ vehicleWeightClass: 'HEAVY' });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
    // Weight check fires first (HEAVY exceeds STANDARD capacity)
    expect(isResourceCompatible(r, j).reason).toContain('exceeds resource capacity');
  });

  it('mobile jack accepts LIGHT vehicle', () => {
    const r = makeResource({ liftType: 'mobile', maxVehicleWeight: 'STANDARD' });
    const j = makeJob({ vehicleWeightClass: 'LIGHT' });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  it('mobile jack accepts STANDARD vehicle', () => {
    const r = makeResource({ liftType: 'mobile', maxVehicleWeight: 'STANDARD' });
    const j = makeJob({ vehicleWeightClass: 'STANDARD' });
    expect(isResourceCompatible(r, j).compatible).toBe(true);
  });

  it('service with mobileJackAllowed=false rejects mobile jack', () => {
    const r = makeResource({ liftType: 'mobile', maxVehicleWeight: 'STANDARD' });
    const j = makeJob({ vehicleWeightClass: 'STANDARD', mobileJackAllowed: false });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
    expect(isResourceCompatible(r, j).reason).toContain('mobile jack not allowed');
  });
});

// DMAIC Rule 3 — mobile jack is sedan-CLASS only (serviceClass-based gate)
describe('DMAIC Rule 3: mobile jack sedan-class gate', () => {
  const mobile = () => makeResource({ liftType: 'mobile', maxVehicleWeight: 'STANDARD' });

  it('eligible: SEDAN_CLASS vehicle is allowed on a mobile jack', () => {
    const res = isResourceCompatible(mobile(), makeJob({ vehicleServiceClass: 'SEDAN_CLASS' }));
    expect(res.compatible).toBe(true);
  });

  it('ineligible: non-sedan (SUV_HEAVY) is blocked with the Rule 3 reason code', () => {
    const res = isResourceCompatible(mobile(), makeJob({ vehicleServiceClass: 'SUV_HEAVY' }));
    expect(res.compatible).toBe(false);
    expect(res.reasonCode).toBe(MOBILE_JACK_NON_SEDAN_REASON);
  });

  it('ineligible: PICKUP / VAN / TRUCK are all blocked on a mobile jack', () => {
    for (const cls of ['PICKUP', 'VAN', 'TRUCK'] as const) {
      const res = isResourceCompatible(mobile(), makeJob({ vehicleServiceClass: cls }));
      expect(res.compatible, cls).toBe(false);
      expect(res.reasonCode, cls).toBe(MOBILE_JACK_NON_SEDAN_REASON);
    }
  });

  it('ineligible: UNKNOWN_REQUIRES_REVIEW is blocked (fail-safe)', () => {
    const res = isResourceCompatible(mobile(), makeJob({ vehicleServiceClass: 'UNKNOWN_REQUIRES_REVIEW' }));
    expect(res.compatible).toBe(false);
    expect(res.reasonCode).toBe(MOBILE_JACK_NON_SEDAN_REASON);
  });

  it('ineligible: missing/null service class is blocked (fail-safe)', () => {
    const res = isResourceCompatible(mobile(), makeJob({ vehicleServiceClass: null }));
    expect(res.compatible).toBe(false);
    expect(res.reasonCode).toBe(MOBILE_JACK_NON_SEDAN_REASON);
  });

  it('non-mobile resources are unaffected by service class (SUV on a stand is fine)', () => {
    const stand = makeResource({ liftType: 'heavy', maxVehicleWeight: 'HEAVY' });
    const res = isResourceCompatible(stand, makeJob({ vehicleServiceClass: 'SUV_HEAVY', vehicleWeightClass: 'HEAVY' }));
    expect(res.compatible).toBe(true);
  });
});

describe('DMAIC: cleaning → power wash gate', () => {
  it('cleaning job only dispatches to POWER_WASH resource', () => {
    const bayR = makeResource({ resourceCategory: 'BAY' });
    const washR = makeResource({ resourceCategory: 'POWER_WASH', liftType: null, isOperational: true });
    const j = makeJob({ requiresPowerWash: true });
    expect(isResourceCompatible(bayR, j).compatible).toBe(false);
    expect(isResourceCompatible(washR, j).compatible).toBe(true);
  });

  it('power wash not operational blocks cleaning', () => {
    const r = makeResource({ resourceCategory: 'POWER_WASH', liftType: null, isOperational: false });
    const j = makeJob({ requiresPowerWash: true });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
    expect(isResourceCompatible(r, j).reason).toContain('not operational');
  });

  it('non-cleaning job cannot use POWER_WASH resource', () => {
    const r = makeResource({ resourceCategory: 'POWER_WASH', liftType: null, isOperational: true });
    const j = makeJob({ requiresPowerWash: false });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
  });
});

describe('DMAIC: machine shop isolation', () => {
  it('external job only uses EXTERNAL resource', () => {
    const bayR = makeResource({ resourceCategory: 'BAY' });
    const extR = makeResource({ resourceCategory: 'EXTERNAL', liftType: null });
    const j = makeJob({ isExternal: true });
    expect(isResourceCompatible(bayR, j).compatible).toBe(false);
    expect(isResourceCompatible(extR, j).compatible).toBe(true);
  });

  it('internal job cannot use EXTERNAL resource', () => {
    const r = makeResource({ resourceCategory: 'EXTERNAL', liftType: null });
    const j = makeJob({ isExternal: false });
    expect(isResourceCompatible(r, j).compatible).toBe(false);
  });
});

describe('DMAIC: stand preference', () => {
  it('stand-preferred job sorts stands first', () => {
    const resources: ResourceState[] = [
      makeResource({ resourceId: 'mj', liftType: 'mobile', maxVehicleWeight: 'STANDARD', isOccupied: false }),
      makeResource({ resourceId: 'st', liftType: 'heavy', maxVehicleWeight: 'HEAVY', isOccupied: false }),
    ];
    const j = makeJob({ standPreferred: true });
    const result = findAvailableResources(resources, j);
    expect(result[0]).toBe('st'); // stand sorted first
  });
});
