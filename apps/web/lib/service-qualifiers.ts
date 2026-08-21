/**
 * CR-2026-092 — the structured qualifiers a conditional service needs before the
 * job can be measured, and which order lines have to be asked for them.
 *
 * Values mirror the API enums exactly (the web app cannot import @prisma/client).
 * Labels are the shop's words rather than the enum's: a technician picking
 * "ROTOR_OR_DISC" off a list is reading a database, not a job card.
 *
 * An axle alone was never an answer for a brake line. Front pads, rear shoes and a
 * fluid bleed are different work carrying different allowances, and the axle only
 * narrows one of them — hence a work type as well.
 */

export type AxlePosition = 'FRONT' | 'REAR' | 'FRONT_AND_REAR' | 'NOT_APPLICABLE';

export type BrakeWorkType =
  | 'PADS'
  | 'SHOES'
  | 'ROTOR_OR_DISC'
  | 'FLUID_OR_BLEED'
  | 'INSPECTION_ONLY'
  | 'OTHER';

export type TireOperation =
  | 'PRESSURE_OR_TREAD_CHECK'
  | 'ROTATION'
  | 'BALANCE'
  | 'ALIGNMENT'
  | 'PUNCTURE_REPAIR'
  | 'REPLACEMENT'
  | 'OTHER_PHYSICAL_WORK';

export type RequiredQualifier = 'NONE' | 'BRAKE' | 'TIRE_OPERATION';

export const AXLE_LABEL: Record<AxlePosition, string> = {
  FRONT: 'Front',
  REAR: 'Rear',
  FRONT_AND_REAR: 'Front & rear',
  NOT_APPLICABLE: 'Not applicable',
};

export const BRAKE_WORK_LABEL: Record<BrakeWorkType, string> = {
  PADS: 'Pads',
  SHOES: 'Shoes',
  ROTOR_OR_DISC: 'Rotor / disc',
  FLUID_OR_BLEED: 'Fluid / bleed',
  INSPECTION_ONLY: 'Inspection only',
  OTHER: 'Other',
};

export const TIRE_OP_LABEL: Record<TireOperation, string> = {
  PRESSURE_OR_TREAD_CHECK: 'Pressure / tread check',
  ROTATION: 'Rotation',
  BALANCE: 'Balance',
  ALIGNMENT: 'Alignment',
  PUNCTURE_REPAIR: 'Puncture repair',
  REPLACEMENT: 'Replacement',
  OTHER_PHYSICAL_WORK: 'Other physical work',
};

export const BRAKE_WORK_OPTIONS: BrakeWorkType[] = [
  'PADS',
  'SHOES',
  'ROTOR_OR_DISC',
  'FLUID_OR_BLEED',
  'INSPECTION_ONLY',
  'OTHER',
];

/**
 * NOT_APPLICABLE is deliberately absent. The calculation reads it as no answer on
 * brake work, so offering it would look like a reply while still leaving the job
 * unmeasurable — the exact dead end this control exists to close.
 */
export const BRAKE_AXLE_OPTIONS: AxlePosition[] = ['FRONT', 'REAR', 'FRONT_AND_REAR'];

export const TIRE_OP_OPTIONS: TireOperation[] = [
  'PRESSURE_OR_TREAD_CHECK',
  'ROTATION',
  'BALANCE',
  'ALIGNMENT',
  'PUNCTURE_REPAIR',
  'REPLACEMENT',
  'OTHER_PHYSICAL_WORK',
];

/** One line on a work order, with whatever qualifiers it already carries. */
export interface QualifierItem {
  id: string;
  serviceType: { id: string; name: string; code: string };
  axlePosition: AxlePosition | null;
  brakeWorkType: BrakeWorkType | null;
  tireOperation: TireOperation | null;
}

/** One outstanding answer, as the API reports it. */
export interface MissingQualifier {
  lineId: string;
  serviceCode: string;
  serviceName: string;
  requiredQualifier: RequiredQualifier;
  message: string;
}

/** Inspection is the one brake activity whose axle genuinely does not matter. */
export function brakeNeedsAxle(workType: BrakeWorkType | null): boolean {
  return workType !== null && workType !== 'INSPECTION_ONLY';
}

/**
 * An axle already on the line stays visible even before a work type is chosen, so a
 * value entered against the wrong axle can be corrected where it was entered.
 */
export function showBrakeAxle(item: QualifierItem): boolean {
  if (item.brakeWorkType === 'INSPECTION_ONLY') return false;
  return brakeNeedsAxle(item.brakeWorkType) || item.axlePosition !== null;
}

/**
 * The resolved qualifier in the shop's words, for display beside the service name.
 * Mirrors the wording the calculation engine puts on its own breakdown lines so the
 * two screens do not describe the same line differently.
 */
export function qualifierSummary(item: QualifierItem): string | null {
  if (item.tireOperation) return `Tyre · ${TIRE_OP_LABEL[item.tireOperation]}`;
  if (item.brakeWorkType === 'INSPECTION_ONLY') return BRAKE_WORK_LABEL.INSPECTION_ONLY;
  if (item.brakeWorkType) {
    return item.axlePosition && item.axlePosition !== 'NOT_APPLICABLE'
      ? `${AXLE_LABEL[item.axlePosition]} · ${BRAKE_WORK_LABEL[item.brakeWorkType]}`
      : BRAKE_WORK_LABEL[item.brakeWorkType];
  }
  if (item.axlePosition) return AXLE_LABEL[item.axlePosition];
  return null;
}

export interface QualifierPrompt {
  item: QualifierItem;
  kind: 'BRAKE' | 'TIRE_OPERATION';
  /** The API's own wording while something is still outstanding, else null. */
  message: string | null;
}

/**
 * Which lines get controls.
 *
 * The API decides what is outstanding: a hard-coded list of "brake-ish" codes here
 * would drift from the admin mapping the first time somebody added a service. Lines
 * that already carry an answer are included too, because a control that disappears
 * the moment it is answered makes a wrong answer unfixable from this screen.
 */
export function qualifierPrompts(
  items: readonly QualifierItem[],
  missing: readonly MissingQualifier[],
): QualifierPrompt[] {
  const outstanding = new Map<string, MissingQualifier>();
  for (const m of missing) {
    if (m.requiredQualifier === 'BRAKE' || m.requiredQualifier === 'TIRE_OPERATION') {
      outstanding.set(m.lineId, m);
    }
  }

  const prompts: QualifierPrompt[] = [];
  for (const item of items) {
    const m = outstanding.get(item.id);
    const kind: QualifierPrompt['kind'] | null = m
      ? (m.requiredQualifier as QualifierPrompt['kind'])
      : item.tireOperation
        ? 'TIRE_OPERATION'
        : item.brakeWorkType || item.axlePosition
          ? 'BRAKE'
          : null;
    if (!kind) continue;
    prompts.push({ item, kind, message: m?.message ?? null });
  }
  return prompts;
}
