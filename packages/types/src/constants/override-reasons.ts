export const OVERRIDE_REASONS = {
  COMMERCIAL_SLA: 'commercial_sla',
  EMERGENCY: 'emergency',
  VIP_CUSTOMER: 'vip_customer',
  OPERATIONAL_EFFICIENCY: 'operational_efficiency',
  ERROR_CORRECTION: 'error_correction',
  COURTESY: 'courtesy',
  OTHER: 'other',
} as const;

export type OverrideReason =
  (typeof OVERRIDE_REASONS)[keyof typeof OVERRIDE_REASONS];

export const OVERRIDE_PRIORITY_MODES = {
  PIN_TO_RANK: 'PIN_TO_RANK',
  PROMOTE_CLASS: 'PROMOTE_CLASS',
} as const;

export type OverridePriorityMode =
  (typeof OVERRIDE_PRIORITY_MODES)[keyof typeof OVERRIDE_PRIORITY_MODES];
