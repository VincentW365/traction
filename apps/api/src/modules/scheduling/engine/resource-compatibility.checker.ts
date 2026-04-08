/**
 * Resource Compatibility Checker (v4.1)
 *
 * Pure function — no database access, no side effects.
 * Determines whether a work resource is compatible with a given job
 * based on vehicle weight class, service requirements, and resource capabilities.
 */

export type VehicleWeight = 'LIGHT' | 'STANDARD' | 'HEAVY';
export type ResourceCategory = 'BAY' | 'OVERFLOW' | 'LIGHT_SLOT';

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
}

export interface JobRequirements {
  vehicleWeightClass: VehicleWeight;
  requiresAlignment: boolean;
  requiresDiagnostics: boolean;
  requiredLiftType: string | null;
  canUseOverflow: boolean;
  canUseLightSlot: boolean;
  appointmentId: string | null;
}

export interface CompatibilityResult {
  compatible: boolean;
  reason: string | null;
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

  // 3. Capability checks
  if (job.requiresAlignment && !resource.hasAlignment) {
    return { compatible: false, reason: 'Resource lacks alignment equipment' };
  }
  if (job.requiresDiagnostics && !resource.hasDiagnostics) {
    return { compatible: false, reason: 'Resource lacks diagnostic equipment' };
  }

  // 4. Lift type check (if a specific lift type is required)
  if (job.requiredLiftType && resource.liftType !== job.requiredLiftType) {
    // Heavy lift can also serve jobs requiring sedan/mobile/power_jack lift
    // But sedan lift cannot serve heavy-lift-required jobs
    // This is already handled by weight check above, so liftType is for specific equipment needs
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
 * Returns resource IDs sorted by display order preference.
 */
export function findAvailableResources(
  resources: ResourceState[],
  job: JobRequirements,
): string[] {
  return resources
    .filter((r) => isResourceAvailableForDispatch(r, job).compatible)
    .map((r) => r.resourceId);
}
