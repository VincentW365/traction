// CR-2026-011 — option lists for the pause/resume/rework controls.
// Mirrors the API enums/DTOs (the web app cannot import @prisma/client).
// Pause reasons must match the PauseReason enum exactly. Rework codes are an
// advisory preset (the rework DTO accepts any non-empty string).

export type PauseReason =
  | 'WAITING_PARTS'
  | 'WAITING_TECH'
  | 'WAITING_BAY'
  | 'CUSTOMER_AUTHORIZATION'
  | 'FURTHER_DIAGNOSIS'
  | 'EXTERNAL_MACHINE_SHOP'
  | 'BREAK_OR_END_OF_DAY'
  | 'OTHER';

// CR-2026-098 — what actually stops work in this shop, most common first.
// WAITING_PARTS is special: the API lands the order in the first-class
// WAITING_PARTS state (visible to advisor/manager parts views, interval
// measured) rather than a generic pause.
export const PAUSE_REASONS: { value: PauseReason; label: string }[] = [
  { value: 'WAITING_PARTS', label: 'Waiting for parts' },
  { value: 'CUSTOMER_AUTHORIZATION', label: 'Waiting for authorization' },
  { value: 'WAITING_TECH', label: 'Waiting for technician assistance' },
  { value: 'WAITING_BAY', label: 'Waiting for bay / equipment' },
  { value: 'FURTHER_DIAGNOSIS', label: 'Needs further diagnosis' },
  { value: 'EXTERNAL_MACHINE_SHOP', label: 'At external machine shop' },
  { value: 'BREAK_OR_END_OF_DAY', label: 'Break / end of day' },
  { value: 'OTHER', label: 'Other' },
];

export const REWORK_REASONS: { value: string; label: string }[] = [
  { value: 'QC_FAIL_BRAKES', label: 'QC fail — brakes' },
  { value: 'QC_FAIL_ALIGNMENT', label: 'QC fail — alignment' },
  { value: 'QC_FAIL_LEAK', label: 'QC fail — leak' },
  { value: 'QC_FAIL_ELECTRICAL', label: 'QC fail — electrical' },
  { value: 'QC_FAIL_OTHER', label: 'QC fail — other' },
];
