/**
 * Scheduling Engine — Internal Types
 *
 * Pure domain types used by the scheduling engine's pure-function stages.
 * These types carry NO NestJS decorators and NO database references.
 * They exist solely to enforce contracts between engine stages.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configurable thresholds and weights for the scheduling engine.
 * Values are loaded from BusinessRuleConfig at runtime by the orchestrator,
 * then passed into pure functions.
 */
export interface SchedulingConfig {
  /** Minutes before scheduled start that still count as "on time" (ARR-002). Default: 30 */
  protectedWindowEarlyMin: number;
  /** Minutes after scheduled start that still count as protected (ARR-002). Default: 15 */
  protectedWindowLateMin: number;
  /** Minutes after scheduled start beyond which the appointment is missed (ARR-005). Default: 30 */
  missedThresholdMin: number;
  /** Score penalty per minute of lateness beyond grace (Scheduling Engine Spec §6). Default: 3 */
  latenessPenaltyPerMin: number;
  /** Score bonus per minute of wait time (Scheduling Engine Spec §6). Default: 2 */
  waitTimeBonusPerMin: number;
  /** Maximum wait-time minutes eligible for bonus (Scheduling Engine Spec §6). Default: 120 */
  waitTimeBonusCapMin: number;
  /** IANA timezone identifier for the site, e.g. 'America/Jamaica' */
  siteTimezone: string;
}

// ---------------------------------------------------------------------------
// Stage 1 — Candidate Set
// ---------------------------------------------------------------------------

/**
 * A flattened, DB-agnostic representation of a ServiceVisit that the
 * scheduling engine can evaluate. The orchestrator is responsible for
 * hydrating this from Prisma models before handing it to the engine.
 */
export interface VisitCandidate {
  serviceVisitId: string;
  appointmentId: string | null;
  sourceType: 'APPOINTMENT' | 'WALKIN';
  /** UTC. Null for walk-ins that have no appointment. */
  scheduledStartAt: Date | null;
  /** UTC timestamp of completed check-in. */
  checkedInAt: Date;
  /** Current ServiceVisitStatus value (as string to avoid Prisma enum import). */
  status: string;
  /** Sum of base_duration_minutes for all requested service types. */
  serviceDurationMinutes: number;
  /** Unique skill_code values required across all requested services. */
  requiredSkillCodes: string[];
  /** Unique bay_type values required across all requested services. */
  requiredBayTypes: string[];
  /** Associated QueueTicket ID. */
  queueTicketId: string;
  /** Monotonic check-in sequence number used as tie-breaker. */
  checkinSequence: number;
  /** True when a manager override is currently active for this visit. */
  overrideActive: boolean;
  /** If overridden, the priority mode the manager selected. */
  overridePriorityMode: string | null;
  /** If overridden, the explicit rank position the manager set. */
  overrideRankPosition: number | null;
}

// ---------------------------------------------------------------------------
// Stage 2 — Eligibility
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a single VisitCandidate against hard constraints.
 * If eligible is false, the visit must not proceed to service start.
 */
export interface EligibilityResult {
  eligible: boolean;
  blockedReason: string | null;
  blockedClass: 'BLOCKED_PARTS' | 'BLOCKED_SKILL' | null;
}

/**
 * Snapshot of resource availability at a site, used for eligibility checks.
 * The orchestrator builds this from the database before calling evaluators.
 */
export interface SiteResources {
  /** All distinct skill_code values for active technicians at the site. */
  technicianSkillCodes: string[];
  /** All distinct bay_type values for active work bays at the site. */
  bayTypes: string[];
}

/**
 * Extended site resources with individual technician/bay details for
 * resource matching (Stage 5).
 */
export interface DetailedSiteResources extends SiteResources {
  technicians: Array<{ id: string; skillCodes: string[] }>;
  bays: Array<{ id: string; bayType: string }>;
}

// ---------------------------------------------------------------------------
// Stage 3 — Classification
// ---------------------------------------------------------------------------

/**
 * The output of priority classification for a single visit.
 * Reason codes are persisted for audit and explainability (Spec §13).
 */
export interface ClassificationResult {
  /** One of the QueuePriorityClass enum values. */
  priorityClass: string;
  /** Machine-readable reason codes explaining the classification. */
  reasonCodes: string[];
}

// ---------------------------------------------------------------------------
// Stage 4 — Scoring
// ---------------------------------------------------------------------------

/**
 * The numeric score assigned to a visit by the scoring calculator.
 * Score drives rank ordering: higher score = higher position in queue.
 * Blocked and missed visits receive a score of 0 and are not ranked.
 */
export interface ScoreResult {
  score: number;
  breakdown: {
    baseWeight: number;
    waitTimeBonus: number;
    latenessPenalty: number;
    /** Phase 2: bonus for quick-service visits (<=30 min) with WALKIN_FASTTRACK. Returns 0 until classifier activates fast-track. */
    quickServiceBonus: number;
    /** Phase 2: bonus for batching compatible services together. Returns 0 until batching logic is activated. */
    batchingBonus: number;
  };
}

// ---------------------------------------------------------------------------
// Stage 5 — Resource Matching
// ---------------------------------------------------------------------------

/**
 * Result of matching a visit's skill/bay requirements against available
 * technicians and bays. Used for decision persistence and future assignment.
 */
export interface ResourceMatchResult {
  candidateTechnicianIds: string[];
  candidateBayIds: string[];
}

// ---------------------------------------------------------------------------
// Stage 6 — Decision Snapshot
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of the scheduling decision for a single visit.
 * Persisted to the queue_decisions table for auditability (Spec §13).
 */
export interface QueueDecisionSnapshot {
  serviceVisitId: string;
  queueTicketId: string;
  priorityClass: string;
  score: number | null;
  blockedReason: string | null;
  reasonCodes: string[];
  candidateTechnicianIds: string[];
  candidateBayIds: string[];
  etaStartAt: Date | null;
  etaCompleteAt: Date | null;
}

// ---------------------------------------------------------------------------
// Full Pipeline Result
// ---------------------------------------------------------------------------

/**
 * A fully ranked visit ready for persistence and display.
 * Rank is 1-based: rank 1 = next to be called.
 * Blocked visits have rank = null (they cannot be ranked).
 */
export interface RankedVisit {
  serviceVisitId: string;
  queueTicketId: string;
  rank: number;
  decision: QueueDecisionSnapshot;
}
