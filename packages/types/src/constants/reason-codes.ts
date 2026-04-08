export const REASON_CODES = {
  APPOINTMENT_PROTECTED: 'appointment_protected',
  ARRIVED_EARLY: 'arrived_early',
  ARRIVED_LATE_SOFT: 'arrived_late_soft',
  MISSED_APPOINTMENT: 'missed_appointment',
  QUICK_LANE_AVAILABLE: 'quick_lane_available',
  BATCHING_APPLIED: 'batching_applied',
  BLOCKED_PARTS: 'blocked_parts',
  BLOCKED_SKILL: 'blocked_skill',
  BLOCKED_BAY: 'blocked_bay',
  FAIRNESS_ESCALATED: 'fairness_escalated',
  MANAGER_OVERRIDE_PINNED: 'manager_override_pinned',
  MANAGER_OVERRIDE_PROMOTED: 'manager_override_promoted',
  SCHEDULER_RANKED: 'scheduler_ranked',
  WALKIN_STANDARD: 'walkin_standard',
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];
