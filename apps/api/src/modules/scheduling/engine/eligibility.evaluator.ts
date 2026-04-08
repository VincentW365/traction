/**
 * Stage 2 — Eligibility Evaluator
 *
 * Determines whether a visit candidate is eligible to proceed to service
 * start. A visit may have high priority but still be ineligible (Spec §3.2).
 *
 * Hard constraints checked (Phase 1, simplified):
 *   1. Must be checked in (status in active-service-eligible set).
 *   2. At least one technician with each required skill_code exists at site.
 *   3. At least one work bay with each required bay_type exists at site.
 *   4. Parts readiness — always passes in Phase 1 (placeholder).
 *
 * Phase 2+ will add:
 *   - Operating hours check
 *   - Double-booking validation
 *   - Proficiency threshold filtering
 *
 * This is a pure function with NO side effects, NO database access,
 * NO NestJS decorators.
 */

import type { VisitCandidate, EligibilityResult, SiteResources } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Statuses that indicate the customer has completed check-in and the visit
 * is in an active state eligible for scheduling to service start.
 */
const CHECKED_IN_STATUSES: ReadonlySet<string> = new Set([
  'CHECKED_IN',
  'QUEUED',
  'CALLED',
  'IN_SERVICE',
  'WAITING_PARTS',
  'QC',
  'READY_FOR_PICKUP',
]);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single visit candidate against site-level hard constraints.
 *
 * Checks are ordered by business impact — the first failing check sets
 * the blocked reason and class, and the function returns immediately.
 * This ensures the most operationally relevant blocker is surfaced.
 *
 * @param visit          The visit candidate to evaluate.
 * @param siteResources  Aggregated resource availability at the site.
 * @returns              Eligibility result with blocked reason if ineligible.
 */
export function evaluateEligibility(
  visit: VisitCandidate,
  siteResources: SiteResources,
): EligibilityResult {
  // --- Check 1: Must be checked in ---
  if (!CHECKED_IN_STATUSES.has(visit.status)) {
    return {
      eligible: false,
      blockedReason: `Visit status '${visit.status}' is not an active checked-in state`,
      blockedClass: null,
    };
  }

  // --- Check 2: Required skills must exist at site ---
  for (const requiredSkill of visit.requiredSkillCodes) {
    if (!siteResources.technicianSkillCodes.includes(requiredSkill)) {
      return {
        eligible: false,
        blockedReason: `No technician with required skill '${requiredSkill}' available at site`,
        blockedClass: 'BLOCKED_SKILL',
      };
    }
  }

  // --- Check 3: Required bay types must exist at site ---
  for (const requiredBay of visit.requiredBayTypes) {
    if (!siteResources.bayTypes.includes(requiredBay)) {
      return {
        eligible: false,
        blockedReason: `No work bay of type '${requiredBay}' available at site`,
        blockedClass: 'BLOCKED_SKILL',
      };
    }
  }

  // --- Check 4: Parts readiness (Phase 1 placeholder — always passes) ---
  // In Phase 3, this will check PartsRequest statuses for mandatory parts.

  return {
    eligible: true,
    blockedReason: null,
    blockedClass: null,
  };
}
