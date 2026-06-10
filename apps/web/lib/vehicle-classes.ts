// CR-2026-009 — shared option lists for the Vehicle Classification UI.
// The web app cannot import @prisma/client, so these mirror the API enums.
// Keep in sync with prisma/schema.prisma (VehicleServiceClass / VehicleWeightClass /
// ClassificationConfidence).

export type VehicleServiceClass =
  | 'SEDAN_CLASS'
  | 'SUV_LIGHT'
  | 'SUV_HEAVY'
  | 'PICKUP'
  | 'VAN'
  | 'TRUCK'
  | 'UNKNOWN_REQUIRES_REVIEW';

export type VehicleWeightClass = 'LIGHT' | 'STANDARD' | 'HEAVY';

export type ClassificationConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export const SERVICE_CLASSES: { value: VehicleServiceClass; label: string }[] = [
  { value: 'SEDAN_CLASS', label: 'Sedan (mobile-jack eligible)' },
  { value: 'SUV_LIGHT', label: 'SUV — Light' },
  { value: 'SUV_HEAVY', label: 'SUV — Heavy' },
  { value: 'PICKUP', label: 'Pickup' },
  { value: 'VAN', label: 'Van' },
  { value: 'TRUCK', label: 'Truck' },
  { value: 'UNKNOWN_REQUIRES_REVIEW', label: 'Unknown — needs review' },
];

export const WEIGHT_CLASSES: { value: VehicleWeightClass; label: string }[] = [
  { value: 'LIGHT', label: 'Light' },
  { value: 'STANDARD', label: 'Standard' },
  { value: 'HEAVY', label: 'Heavy' },
];

export const CONFIDENCE_FILTERS: { value: '' | ClassificationConfidence; label: string }[] = [
  { value: '', label: 'All confidence' },
  { value: 'HIGH', label: 'High' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'LOW', label: 'Low' },
  { value: 'NONE', label: 'None (no suggestion)' },
];

/** Tailwind classes for a small confidence badge. */
export function confidenceBadgeClass(c: ClassificationConfidence): string {
  switch (c) {
    case 'HIGH':
      return 'bg-green-100 text-green-700 border border-green-200';
    case 'MEDIUM':
      return 'bg-blue-100 text-blue-700 border border-blue-200';
    case 'LOW':
      return 'bg-amber-100 text-amber-700 border border-amber-200';
    default:
      return 'bg-slate-100 text-slate-500 border border-slate-200';
  }
}

export function serviceClassLabel(v: VehicleServiceClass | null): string {
  if (!v) return '—';
  return SERVICE_CLASSES.find((s) => s.value === v)?.label ?? v;
}
