import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAppointmentDuration, toVehicleClass, type MeasurableService } from '../service-duration';

/**
 * CR-2026-111d — the operational boundaries the cohesion audit pinned.
 *
 * Three claims that are true today and would be easy to break by accident:
 *
 *  §3  `bookableOnline` is a CUSTOMER eligibility control. No staff service query
 *      may filter on it — staff select from the operational catalogue.
 *
 *  §24 RESOURCE_AWARE SHADOW has no production authority while
 *      `booking_capacity_mode = FIXED`. It may calculate, compare, log and flag;
 *      nothing in the appointment, dispatch, service-order, walk-in or check-in
 *      path may consult it.
 *
 *  §2  Technician assignment is a `WorkBay` operation. The `WorkResource` registry
 *      is a parallel, optional column and must not gate or replace it until an
 *      explicit migration is designed.
 *
 * These are source-level assertions on purpose: the failure mode is a reviewer
 * missing one extra `where` clause or one extra import, and a test that reads the
 * file catches exactly that. Behavioural coverage of the same paths lives in the
 * live operational audit (`pnpm audit:operational`).
 */

const root = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const STAFF_PATHS = [
  'appointments/appointments.service.ts',
  'service-orders/service-orders.service.ts',
  'walk-ins/walk-ins.service.ts',
  'appointments/check-in.service.ts',
  'scheduling/scheduling.service.ts',
];

// ---------------------------------------------------------------------------

describe('§3 staff service selection is broader than public booking', () => {
  it('no staff path filters ServiceType on bookableOnline', () => {
    for (const rel of STAFF_PATHS) {
      const src = read(rel);
      // A `where` that mentions bookableOnline would narrow staff to the customer catalogue.
      expect(src, rel).not.toMatch(/bookableOnline\s*:\s*(true|false|\{)/);
    }
  });

  it('only the public booking module and the read-only readiness report filter on it', () => {
    const allowed = ['public-booking/public-booking.service.ts', 'config/catalogue-readiness.service.ts'];
    for (const rel of allowed) {
      expect(read(rel), rel).toMatch(/bookableOnline/);
    }
  });

  it('staff service queries require only that the service is active', () => {
    for (const rel of ['appointments/appointments.service.ts', 'service-orders/service-orders.service.ts', 'walk-ins/walk-ins.service.ts']) {
      const src = read(rel);
      expect(src, rel).toMatch(/where:\s*\{\s*code:\s*\{\s*in:\s*uniqueCodes\s*\},\s*isActive:\s*true\s*\}/);
    }
  });
});

// ---------------------------------------------------------------------------

describe('§24 RESOURCE_AWARE SHADOW has no operational authority', () => {
  const SHADOW_SERVICES = ['ResourceAvailabilityService', 'ShadowComparisonService', 'ResourceReservationService', 'evaluateResourceCapacity'];

  it('no operational path imports or calls the shadow resource engine', () => {
    for (const rel of STAFF_PATHS) {
      const src = read(rel);
      for (const name of SHADOW_SERVICES) {
        expect(src, `${rel} → ${name}`).not.toContain(name);
      }
    }
  });

  it('the shadow engine is consulted only by readiness and the comparison recorder', () => {
    // CR-2026-121 — the Booking Simulator, its other caller, has been removed.
    const callers = ['scheduling/availability/shadow-comparison.service.ts'];
    for (const rel of callers) {
      expect(read(rel), rel).toMatch(/\.snapshot\(|\.evaluate\(/);
    }
  });

  it('the capacity mode changes only the ETA capacity NUMBER, never a gate', () => {
    const eta = read('scheduling/eta/eta.service.ts');
    // The one place the mode is read: it aggregates resource capacity into a count.
    expect(eta).toMatch(/if \(cfg\.capacityMode === 'RESOURCES'\)/);
    expect(eta).toMatch(/cfg\.capacity = sum > 0 \? sum : cfg\.capacity/);
    // And it throws nothing, blocks nothing.
    const block = eta.slice(eta.indexOf("if (cfg.capacityMode === 'RESOURCES')"), eta.indexOf('return cfg;'));
    expect(block).not.toMatch(/throw|BadRequest|Conflict|Forbidden/);
  });

  it('nothing outside the reservation service writes a ResourceReservation', () => {
    for (const rel of STAFF_PATHS) {
      expect(read(rel), rel).not.toMatch(/resourceReservation\.(create|createMany|update|updateMany|delete|deleteMany)/);
    }
  });

  it('switching the mode to RESOURCE_AWARE is guarded by a preflight, not a bare write', () => {
    const cfg = read('config/config.service.ts');
    expect(cfg).toContain("ruleKey === 'booking_capacity_mode'");
    expect(cfg).toContain('RESOURCE_AWARE_PREFLIGHT_FAILED');
  });
});

// ---------------------------------------------------------------------------

describe('§2 technician assignment stays on WorkBay', () => {
  const so = read('service-orders/service-orders.service.ts');

  it('the primary assignment writes bayId and validates against WorkBay.bayType', () => {
    expect(so).toMatch(/technicianAssignment\.create\(\{\s*data:\s*\{[^}]*bayId:\s*bay\.id/s);
    expect(so).toContain('does not match required bay type');
  });

  it('assignment never requires a WorkResource to exist', () => {
    // resourceId is written only where a caller explicitly supplied one (assign-additional),
    // and always as nullable — never looked up or demanded.
    expect(so).toMatch(/resourceId:\s*resourceId \?\? null/);
    expect(so).not.toMatch(/workResource\.findUnique|workResource\.findFirst|workResource\.findMany/);
  });

  it('no operational path deletes orders or assignments on the resource side', () => {
    for (const rel of ['resources/resource-admin.service.ts', 'resources/resources.service.ts', 'resources/resource-readiness.service.ts']) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/serviceOrder\.delete|technicianAssignment\.delete/);
    }
  });
});

// ---------------------------------------------------------------------------

describe('toVehicleClass — the third enum value is handled on purpose', () => {
  const GEN_SERV: MeasurableService = { code: 'GEN-SERV-01', baseDurationMinutes: 90, sedanDurationMinutes: 90, suvDurationMinutes: 120 };

  it('passes the two known classes through', () => {
    expect(toVehicleClass('SEDAN_CLASS')).toBe('SEDAN_CLASS');
    expect(toVehicleClass('SUV_CLASS')).toBe('SUV_CLASS');
  });

  it('treats UNKNOWN_REQUIRES_REVIEW as unknown — explicitly, not by accident of a cast', () => {
    expect(toVehicleClass('UNKNOWN_REQUIRES_REVIEW')).toBeNull();
    expect(toVehicleClass(null)).toBeNull();
    expect(toVehicleClass(undefined)).toBeNull();
    expect(toVehicleClass('SOMETHING_NEW')).toBeNull();
  });

  /** 5,000+ vehicles carry this value. They must plan conservatively, not as sedans. */
  it('a vehicle flagged for review plans General Servicing at 120, never 90', () => {
    const r = resolveAppointmentDuration({
      services: [GEN_SERV],
      vehicleClass: toVehicleClass('UNKNOWN_REQUIRES_REVIEW'),
      policy: 'CATALOGUE',
      defaultMinutes: 80,
    });
    expect(r.plannedMinutes).toBe(120);
    expect(r.classBasis).toBe('UNKNOWN_ASSUMED_LONGEST');
  });

  it('no operational path casts serviceClass straight to VehicleClass any more', () => {
    for (const rel of [...STAFF_PATHS, 'scheduling/availability/booking-availability.service.ts']) {
      expect(read(rel), rel).not.toMatch(/serviceClass[^\n]*as VehicleClass/);
    }
  });
});
