/**
 * Resource Compatibility Checker (DMAIC-aligned)
 *
 * Pure function — no database access, no side effects.
 * Determines whether a work resource is compatible with a given job
 * based on vehicle weight class, service requirements, resource capabilities,
 * and DMAIC operational rules (mobile jack sedan restriction, power wash gate,
 * machine shop isolation, mobileJackAllowed flag).
 */

export type VehicleWeight = 'LIGHT' | 'STANDARD' | 'HEAVY';
export type ResourceCategory = 'BAY' | 'OVERFLOW' | 'LIGHT_SLOT' | 'POWER_WASH' | 'EXTERNAL';
export type VehicleServiceClass =
  | 'SEDAN_CLASS'
  | 'SUV_LIGHT'
  | 'SUV_HEAVY'
  | 'PICKUP'
  | 'VAN'
  | 'TRUCK'
  | 'UNKNOWN_REQUIRES_REVIEW';

/** Reason code emitted when a mobile jack is blocked for a non-sedan vehicle (DMAIC Rule 3). */
export const MOBILE_JACK_NON_SEDAN_REASON = 'MOBILE_JACK_NON_SEDAN';

export interface ResourceState {
  resourceId: string;
  code: string;
  resourceCategory: ResourceCategory;
  maxVehicleWeight: VehicleWeight | null;
  liftType: string | null;
  hasAlignment: boolean;
  hasDiagnostics: boolean;
  requiresMechanic: boolean;
  isOccupied: boolean;
  /** True if a reservation is active within the activation window for another appointment */
  hasImminentReservation: boolean;
  reservedForAppointmentId: string | null;
  /** True if the resource is currently operational (used for power wash status checks) */
  isOperational: boolean;
}

export interface JobRequirements {
  vehicleWeightClass: VehicleWeight;
  /** DMAIC Rule 3 — operational vehicle class; only SEDAN_CLASS may use mobile jacks. */
  vehicleServiceClass: VehicleServiceClass | null;
  requiresAlignment: boolean;
  requiresDiagnostics: boolean;
  requiredLiftType: string | null;
  canUseOverflow: boolean;
  canUseLightSlot: boolean;
  appointmentId: string | null;
  // DMAIC flags
  requiresPowerWash: boolean;
  isExternal: boolean;
  mobileJackAllowed: boolean;
  standPreferred: boolean;
}

export interface CompatibilityResult {
  compatible: boolean;
  reason: string | null;
  /** Machine-readable reason code for gates the caller may override (e.g. mobile-jack sedan rule). */
  reasonCode?: string;
}

const WEIGHT_ORDER: Record<VehicleWeight, number> = {
  LIGHT: 1,
  STANDARD: 2,
  HEAVY: 3,
};

/**
 * Check if a single resource is compatible with a job's requirements.
 */
export function isResourceCompatible(
  resource: ResourceState,
  job: JobRequirements,
): CompatibilityResult {
  // --- DMAIC: Machine shop isolation ---
  // External jobs can ONLY use EXTERNAL resources
  if (job.isExternal && resource.resourceCategory !== 'EXTERNAL') {
    return { compatible: false, reason: 'Machine shop jobs dispatched externally only' };
  }
  // Internal jobs cannot use EXTERNAL resources
  if (!job.isExternal && resource.resourceCategory === 'EXTERNAL') {
    return { compatible: false, reason: 'Internal jobs cannot use external resource' };
  }

  // --- DMAIC: Cleaning → power wash gate ---
  // Cleaning jobs require POWER_WASH resource
  if (job.requiresPowerWash && resource.resourceCategory !== 'POWER_WASH') {
    return { compatible: false, reason: 'Cleaning requires power wash resource' };
  }
  // Non-cleaning jobs cannot use POWER_WASH resource
  if (!job.requiresPowerWash && resource.resourceCategory === 'POWER_WASH') {
    return { compatible: false, reason: 'Non-cleaning jobs cannot use power wash slot' };
  }
  // Power wash resource must be operational
  if (resource.resourceCategory === 'POWER_WASH' && !resource.isOperational) {
    return { compatible: false, reason: 'Power wash machine is not operational' };
  }

  // 1. Category check: can this job use this type of resource?
  if (resource.resourceCategory === 'OVERFLOW' && !job.canUseOverflow) {
    return { compatible: false, reason: 'Service cannot use overflow space' };
  }
  if (resource.resourceCategory === 'LIGHT_SLOT' && !job.canUseLightSlot) {
    return { compatible: false, reason: 'Service cannot use light task slot' };
  }

  // 2. Weight check: can this resource handle the vehicle?
  if (resource.maxVehicleWeight !== null) {
    const resourceCapacity = WEIGHT_ORDER[resource.maxVehicleWeight];
    const vehicleWeight = WEIGHT_ORDER[job.vehicleWeightClass];
    if (vehicleWeight > resourceCapacity) {
      return {
        compatible: false,
        reason: `Vehicle (${job.vehicleWeightClass}) exceeds resource capacity (${resource.maxVehicleWeight})`,
      };
    }
  }

  // --- DMAIC Rule 3: Mobile jack sedan-only restriction ---
  // Mobile jacks may ONLY serve SEDAN_CLASS vehicles. Anything else — including
  // UNKNOWN_REQUIRES_REVIEW or a missing class — is blocked here. A manager override
  // is applied at the assignment boundary (this pure checker stays deterministic).
  if (resource.liftType === 'mobile' && job.vehicleServiceClass !== 'SEDAN_CLASS') {
    return {
      compatible: false,
      reason: `Mobile jack is sedan-only; vehicle class is ${job.vehicleServiceClass ?? 'UNKNOWN'}`,
      reasonCode: MOBILE_JACK_NON_SEDAN_REASON,
    };
  }
  // Service-level mobile jack restriction (e.g., battery change = mobileJackAllowed: false)
  if (resource.liftType === 'mobile' && !job.mobileJackAllowed) {
    return { compatible: false, reason: 'Service requires stand — mobile jack not allowed' };
  }

  // 3. Capability checks
  if (job.requiresAlignment && !resource.hasAlignment) {
    return { compatible: false, reason: 'Resource lacks alignment equipment' };
  }
  if (job.requiresDiagnostics && !resource.hasDiagnostics) {
    return { compatible: false, reason: 'Resource lacks diagnostic equipment' };
  }

  // 4. Lift type check (if a specific lift type is required)
  if (job.requiredLiftType && resource.liftType !== job.requiredLiftType) {
    return {
      compatible: false,
      reason: `Requires ${job.requiredLiftType} lift, resource has ${resource.liftType ?? 'no lift'}`,
    };
  }

  return { compatible: true, reason: null };
}

/**
 * Check if a resource is available for dispatch (compatible + free + not reserved for someone else).
 */
export function isResourceAvailableForDispatch(
  resource: ResourceState,
  job: JobRequirements,
): CompatibilityResult {
  // First check compatibility
  const compat = isResourceCompatible(resource, job);
  if (!compat.compatible) return compat;

  // Check occupancy
  if (resource.isOccupied) {
    return { compatible: false, reason: 'Resource is currently occupied' };
  }

  // Check reservations: if resource is reserved for another appointment, skip it
  if (
    resource.hasImminentReservation &&
    resource.reservedForAppointmentId !== null &&
    resource.reservedForAppointmentId !== job.appointmentId
  ) {
    return { compatible: false, reason: 'Resource reserved for upcoming appointment' };
  }

  return { compatible: true, reason: null };
}

/**
 * Find all compatible and available resources for a job.
 * Returns resource IDs sorted by preference:
 * - Stand-preferred jobs sort stands first
 * - Then by display order
 */
export function findAvailableResources(
  resources: ResourceState[],
  job: JobRequirements,
): string[] {
  const available = resources.filter(
    (r) => isResourceAvailableForDispatch(r, job).compatible,
  );

  // DMAIC: Stand preference — sort stands first for standPreferred jobs
  if (job.standPreferred) {
    available.sort((a, b) => {
      const aIsStand = a.liftType === 'heavy' ? 0 : 1;
      const bIsStand = b.liftType === 'heavy' ? 0 : 1;
      return aIsStand - bIsStand;
    });
  }

  return available.map((r) => r.resourceId);
}
