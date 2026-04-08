/**
 * Stage 5 — Resource Matcher
 *
 * Finds compatible technicians and bays for a visit.
 * Phase 1: existence check only (no real-time availability tracking).
 */

import type {
  VisitCandidate,
  DetailedSiteResources,
  ResourceMatchResult,
} from './types';

export function matchResources(
  visit: VisitCandidate,
  resources: DetailedSiteResources,
): ResourceMatchResult {
  // Find technicians who have ALL required skill codes
  const candidateTechnicianIds = resources.technicians
    .filter((tech) =>
      visit.requiredSkillCodes.every((skill) =>
        tech.skillCodes.includes(skill),
      ),
    )
    .map((tech) => tech.id);

  // Find bays whose type matches ANY of the required bay types
  const candidateBayIds = resources.bays
    .filter((bay) => visit.requiredBayTypes.includes(bay.bayType))
    .map((bay) => bay.id);

  return { candidateTechnicianIds, candidateBayIds };
}
