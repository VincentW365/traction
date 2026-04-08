import type { QueuePriorityClass } from '../enums';

export const BASE_PRIORITY_WEIGHTS: Record<QueuePriorityClass, number> = {
  APPT_PROTECTED: 1000,
  APPT_LATE_SOFT: 800,
  WALKIN_FASTTRACK: 650,
  WALKIN_STANDARD: 600,
  BLOCKED_PARTS: 0,
  BLOCKED_SKILL: 0,
  MISSED_APPOINTMENT: 0,
  MANUAL_OVERRIDE: 0, // Handled via override lifecycle, not base weight
};
