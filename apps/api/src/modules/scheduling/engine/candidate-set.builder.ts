/**
 * Stage 1 — Candidate Set Builder
 *
 * Filters the raw list of ServiceVisit records for a site/day down to only
 * those that are still active and eligible for scheduling consideration.
 *
 * Per Scheduling Engine Spec §4 (Stage 1), the following statuses are
 * excluded from the candidate set:
 *   - COMPLETED  (work finished)
 *   - CLOSED     (visit finalized)
 *   - CANCELLED  (visit cancelled)
 *   - ABANDONED  (customer left)
 *
 * Active statuses that remain in the candidate set:
 *   - CREATED, ARRIVED, CHECKED_IN, QUEUED, CALLED, IN_SERVICE,
 *     WAITING_PARTS, QC, READY_FOR_PICKUP
 *
 * This is a pure function with NO side effects, NO database access,
 * NO NestJS decorators.
 */

import type { VisitCandidate } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * ServiceVisitStatus values that exclude a visit from the active candidate set.
 * Kept as a Set for O(1) lookup.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'CLOSED',
  'CANCELLED',
  'ABANDONED',
]);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the candidate set by filtering out visits in terminal states.
 *
 * @param visits  All ServiceVisit records for the site/day, mapped to VisitCandidate.
 * @returns       Only visits whose status is not in the terminal set.
 */
export function buildCandidateSet(visits: VisitCandidate[]): VisitCandidate[] {
  return visits.filter((visit) => !TERMINAL_STATUSES.has(visit.status));
}
