/**
 * CR-2026-111b — the ONE service-duration resolver.
 *
 * Every scheduling path asks this module how long an appointment is: public
 * availability, public confirm, customer reschedule, staff availability, staff
 * create, staff reschedule. There is no second copy of the sedan/SUV rule.
 *
 * Two concepts are kept deliberately apart (§6):
 *
 *   CATALOGUE DURATION — what this service, for this vehicle, is configured to
 *     take. General Servicing is 90 minutes for a sedan and 120 for an SUV. This
 *     is a fact about the work and is computed ALWAYS, whatever policy is active,
 *     so the two can be compared and an activation decision can be made on
 *     evidence rather than on hope.
 *
 *   DURATION POLICY — what scheduling is currently instructed to plan with.
 *     `DEFAULT` plans every service at one flat figure; `CATALOGUE` plans each
 *     service at its own configured duration. This is a production setting, not a
 *     property of the work.
 *
 * `DEFAULT` means EXACTLY the flat default for every service, with no exceptions
 * (§7). There is no per-service escape hatch here, and adding one silently would
 * be worse than the divergence it papered over. When the policy plans a service
 * shorter than its configured duration, the resolver says so in
 * `underPlannedByMinutes` and callers can refuse to activate rather than quietly
 * selling a slot too short for the job.
 *
 * Pure. No I/O, no Prisma, no Nest.
 */

/** The vehicle classes that change a duration. `null` = not classified. */
export type VehicleClass = 'SEDAN_CLASS' | 'SUV_CLASS' | null;

/** What scheduling is currently instructed to plan with. */
export type DurationPolicy = 'DEFAULT' | 'CATALOGUE';

/**
 * The one Prisma select for anything that will be measured.
 *
 * Defect A was a select that listed `baseDurationMinutes` and nothing else, so the
 * class columns arrived as `undefined` and every vehicle silently got the base
 * figure. Using this constant is how a call site cannot forget them; the required
 * fields on `MeasurableService` are how the compiler catches one that tries.
 */
export const SERVICE_DURATION_SELECT = {
  id: true,
  code: true,
  name: true,
  baseDurationMinutes: true,
  sedanDurationMinutes: true,
  suvDurationMinutes: true,
} as const;

/**
 * A service as the duration calculation must see it.
 *
 * The class columns are REQUIRED, not optional. They were optional once, "so every
 * existing caller keeps compiling" — and that is exactly how the staff path came to
 * plan an SUV general service at 90 minutes while the customer path planned 120.
 * A caller that has not loaded these columns should fail to compile, loudly, rather
 * than quietly resolve to the shorter number.
 */
export interface MeasurableService {
  baseDurationMinutes: number | null;
  sedanDurationMinutes: number | null;
  suvDurationMinutes: number | null;
  code?: string;
}

/** How the vehicle class was decided, which matters when it could not be. */
export type ClassBasis =
  /** The vehicle record says sedan. */
  | 'SEDAN'
  /** The vehicle record says SUV. */
  | 'SUV'
  /** Not classified, and the service charges the same for everything. */
  | 'NOT_APPLICABLE'
  /** Not classified, and the service does vary — so the LONGEST was assumed (§5). */
  | 'UNKNOWN_ASSUMED_LONGEST';

export interface DurationResolution {
  /** What scheduling should actually plan. Never zero. */
  plannedMinutes: number;
  /** What the services are configured to take for this vehicle, whatever the policy. */
  catalogueMinutes: number;
  /** The policy that produced `plannedMinutes`. */
  policy: DurationPolicy;
  /** How the class was decided. */
  classBasis: ClassBasis;
  /**
   * How far the plan falls SHORT of the configured duration. Zero when the plan is
   * equal or longer. Over-planning wastes a little capacity; under-planning runs a
   * job past its slot and into the next customer's, so only the shortfall is named.
   */
  underPlannedByMinutes: number;
  /** One sentence a human can read in a preflight report. */
  explanation: string;
}

/**
 * Does this service charge different durations by vehicle class?
 *
 * Takes only the two columns it reads, so a caller can ask the question before it
 * has loaded anything else — that is how the staff paths decide whether looking up
 * the vehicle is worth a query at all.
 */
export function variesByVehicleClass(service: Pick<MeasurableService, 'sedanDurationMinutes' | 'suvDurationMinutes'>): boolean {
  return positive(service.sedanDurationMinutes) || positive(service.suvDurationMinutes);
}

function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && n > 0;
}

/**
 * Guard against Defect A at runtime.
 *
 * The compiler catches a typed call site that forgot the columns. This catches the
 * ones that reach here through `any` — a Prisma payload widened by an `as`, a test
 * fixture, a JSON round-trip. `undefined` means "never selected"; `null` means
 * "selected, and this service has no class-specific figure". The difference is the
 * whole defect, so it is not collapsed.
 */
function assertColumnsLoaded(service: MeasurableService): void {
  if (service.sedanDurationMinutes === undefined || service.suvDurationMinutes === undefined) {
    throw new Error(
      `Service ${service.code ?? '(unknown)'} was loaded without its vehicle-class duration columns. ` +
        'Select SERVICE_DURATION_SELECT — resolving a duration from baseDurationMinutes alone silently ' +
        'under-plans every SUV.',
    );
  }
}

/**
 * The configured duration of ONE service for one vehicle class.
 *
 * Unknown class is the interesting case. A service that varies by class and a
 * vehicle nobody has classified is a genuine gap, and the safe side of that gap is
 * the LONGER figure (§5): over-planning costs a little capacity, under-planning
 * runs the job into the next customer's slot. It never silently picks sedan just
 * because sedan is the base.
 */
export function catalogueMinutesFor(service: MeasurableService, vehicleClass: VehicleClass): number {
  assertColumnsLoaded(service);
  const base = positive(service.baseDurationMinutes) ? service.baseDurationMinutes : 0;

  if (!variesByVehicleClass(service)) return base;

  if (vehicleClass === 'SUV_CLASS') return positive(service.suvDurationMinutes) ? service.suvDurationMinutes : base;
  if (vehicleClass === 'SEDAN_CLASS') return positive(service.sedanDurationMinutes) ? service.sedanDurationMinutes : base;

  // Unclassified, and this service does vary. Take the longest configured figure.
  return Math.max(
    base,
    positive(service.sedanDurationMinutes) ? service.sedanDurationMinutes : 0,
    positive(service.suvDurationMinutes) ? service.suvDurationMinutes : 0,
  );
}

function classBasisFor(services: MeasurableService[], vehicleClass: VehicleClass): ClassBasis {
  if (vehicleClass === 'SUV_CLASS') return 'SUV';
  if (vehicleClass === 'SEDAN_CLASS') return 'SEDAN';
  return services.some(variesByVehicleClass) ? 'UNKNOWN_ASSUMED_LONGEST' : 'NOT_APPLICABLE';
}

export interface ResolveInput {
  services: MeasurableService[];
  vehicleClass: VehicleClass;
  policy: DurationPolicy;
  /** The flat figure `DEFAULT` plans with, and the fallback when nothing is configured. */
  defaultMinutes: number;
}

/**
 * The authoritative answer for every scheduling path.
 *
 * The same vehicle and the same service resolve to the same planned duration
 * whether the appointment came from a customer, a Service Advisor or a Manager
 * (§4). `sourceChannel` is not an input here, and must never become one.
 */
export function resolveAppointmentDuration({
  services,
  vehicleClass,
  policy,
  defaultMinutes,
}: ResolveInput): DurationResolution {
  const catalogueMinutes = services.reduce((sum, s) => sum + Math.max(0, catalogueMinutesFor(s, vehicleClass)), 0);
  const classBasis = classBasisFor(services, vehicleClass);

  // DEFAULT is exactly the flat figure for every service — no per-service exception.
  const plannedMinutes = policy === 'CATALOGUE' && catalogueMinutes > 0 ? catalogueMinutes : defaultMinutes;
  const underPlannedByMinutes = Math.max(0, catalogueMinutes - plannedMinutes);

  return {
    plannedMinutes,
    catalogueMinutes,
    policy,
    classBasis,
    underPlannedByMinutes,
    explanation: explain({ plannedMinutes, catalogueMinutes, policy, classBasis, underPlannedByMinutes }),
  };
}

function explain(r: Omit<DurationResolution, 'explanation'>): string {
  const how =
    r.classBasis === 'UNKNOWN_ASSUMED_LONGEST'
      ? 'vehicle class unknown, so the longest configured duration was assumed'
      : r.classBasis === 'NOT_APPLICABLE'
        ? 'this service takes the same time for every vehicle'
        : `vehicle class ${r.classBasis.toLowerCase()}`;

  if (r.policy === 'DEFAULT') {
    const gap =
      r.underPlannedByMinutes > 0
        ? ` — ${r.underPlannedByMinutes} minutes SHORT of the ${r.catalogueMinutes}-minute configured duration`
        : r.catalogueMinutes > 0
          ? ` — the configured duration is ${r.catalogueMinutes} minutes, so the plan is longer than the work needs`
          : '';
    return `Planned at the flat ${r.plannedMinutes}-minute default (${how})${gap}.`;
  }
  return `Planned at the configured ${r.plannedMinutes} minutes (${how}).`;
}
