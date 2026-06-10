// CR-2026-011 — option lists for the pause/resume/rework controls.
// Mirrors the API enums/DTOs (the web app cannot import @prisma/client).
// Pause reasons must match the PauseReason enum exactly. Rework codes are an
// advisory preset (the rework DTO accepts any non-empty string).

export type PauseReason =
  | 'WAITING_TECH'
  | 'WAITING_BAY'
  | 'CUSTOMER_AUTHORIZATION'
  | 'EXTERNAL_MACHINE_SHOP'
  | 'BREAK_OR_END_OF_DAY'
  | 'OTHER';

export const PAUSE_REASONS: { value: PauseReason; label: string }[] = [
  { value: 'WAITING_TECH', label: 'Waiting on technician' },
  { value: 'WAITING_BAY', label: 'Waiting on bay' },
  { value: 'CUSTOMER_AUTHORIZATION', label: 'Customer authorization' },
  { value: 'EXTERNAL_MACHINE_SHOP', label: 'External machine shop' },
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
