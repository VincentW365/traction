/**
 * Parts Readiness Checker (v4.1)
 *
 * Pure function — no database access, no side effects.
 * Derives the parts readiness state from service types and parts request data.
 *
 * Source of truth: PartsRequest + PartsRequestItem
 * ServiceVisit.partsReadiness is a cached projection updated by this function.
 */

export type PartsReadinessState =
  | 'NOT_REQUIRED'
  | 'UNCONFIRMED'
  | 'REQUIRED_NOT_READY'
  | 'READY';

export interface ServiceTypeInfo {
  partsPrepositionRequired: boolean;
}

export interface PartsRequestInfo {
  status: string;
  items: Array<{
    criticalFlag: boolean;
    status: string;
  }>;
}

const TERMINAL_ITEM_STATUSES = ['FULFILLED', 'RECEIVED', 'CLOSED', 'CANCELLED'];

/**
 * Derive the parts readiness state from source data.
 *
 * Logic:
 * - No service needs parts AND no requests exist → NOT_REQUIRED
 * - A service needs parts but no request created yet → UNCONFIRMED (warning, not blocking)
 * - Request exists with unresolved critical items → REQUIRED_NOT_READY (blocking)
 * - Request exists and all critical items resolved → READY
 */
export function derivePartsReadiness(
  serviceTypes: ServiceTypeInfo[],
  partsRequests: PartsRequestInfo[],
): PartsReadinessState {
  const anyServiceNeedsParts = serviceTypes.some(
    (st) => st.partsPrepositionRequired,
  );

  // No service needs parts and no requests exist
  if (!anyServiceNeedsParts && partsRequests.length === 0) {
    return 'NOT_REQUIRED';
  }

  // Service needs parts but no request has been created yet
  if (anyServiceNeedsParts && partsRequests.length === 0) {
    return 'UNCONFIRMED';
  }

  // Requests exist — check if all critical items are resolved
  // Only look at non-cancelled requests
  const activeRequests = partsRequests.filter(
    (pr) => pr.status !== 'CANCELLED',
  );

  if (activeRequests.length === 0) {
    // All requests were cancelled — treat as if no requests exist
    return anyServiceNeedsParts ? 'UNCONFIRMED' : 'NOT_REQUIRED';
  }

  const allCriticalReady = activeRequests.every((pr) => {
    const criticalItems = pr.items.filter((item) => item.criticalFlag);
    // If no critical items in this request, it doesn't block
    if (criticalItems.length === 0) return true;
    return criticalItems.every((item) =>
      TERMINAL_ITEM_STATUSES.includes(item.status),
    );
  });

  return allCriticalReady ? 'READY' : 'REQUIRED_NOT_READY';
}

/**
 * Check if a visit is dispatchable from a parts perspective.
 * REQUIRED_NOT_READY blocks dispatch. All other states allow it.
 */
export function isPartsReadyForDispatch(
  readiness: PartsReadinessState,
): boolean {
  return readiness !== 'REQUIRED_NOT_READY';
}
