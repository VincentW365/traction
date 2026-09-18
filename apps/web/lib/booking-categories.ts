/**
 * CR-2026-111 — what a customer sees instead of the service catalogue.
 *
 * The booking page used to render ServiceType rows. That is the shop's own
 * vocabulary — "BRK-02", "Estimate / Inspection", both DISC-01 and its superseded
 * twin — and it asks a customer to know which internal code describes the noise
 * their car is making. Most of them do not, so they guess, and an advisor
 * discovers the guess when the vehicle arrives.
 *
 * These categories are PRESENTATION. Every one resolves to approved ServiceType
 * codes; none of them invents a service, and none bypasses `bookableOnline`. What
 * a customer types stays customer text — concern, symptoms, comments — and never
 * becomes a substitute for structured service data.
 *
 * Pure data and pure functions, no React, so the mapping is testable without
 * rendering anything.
 */

export type CategoryKey =
  | 'GENERAL_SERVICING'
  | 'OIL_CHANGE'
  | 'BATTERY'
  | 'BRAKES'
  | 'TIRES'
  | 'INSPECTION'
  | 'CLEANING'
  | 'OTHER';

export interface SymptomOption {
  code: string;
  label: string;
}

/**
 * One thing a customer can choose inside a category.
 *
 * `serviceCodes` is what it books. An option with NO codes is a concern rather
 * than a request — "brake noise" is not a diagnosis, and booking a pad
 * replacement off the back of it would decide the repair before anyone has
 * looked at the car. Those fall through to the assessment service.
 */
export interface CategoryOption {
  key: string;
  label: string;
  help?: string;
  /** Approved codes this books. Empty = route to assessment (see `fallsBackToAssessment`). */
  serviceCodes: string[];
  /** True when the option describes a problem rather than requesting known work. */
  fallsBackToAssessment?: boolean;
}

export interface BookingCategory {
  key: CategoryKey;
  title: string;
  description: string;
  icon: 'wrench' | 'oil' | 'battery' | 'brake' | 'tire' | 'clipboard' | 'sparkle' | 'question';
  /** Codes booked when the category needs no further choice. */
  serviceCodes: string[];
  /** Presented when the category has meaningfully different customer intents. */
  options?: CategoryOption[];
  /** Ticked, not typed. Intake information — never read as a diagnosis. */
  symptoms?: SymptomOption[];
  /** The customer must describe the problem before they can continue. */
  requiresConcern?: boolean;
  /** Shown under the card. Indicative only; the real figure comes from the API. */
  approxMinutes?: number;
}

/** The service every "I don't know" path resolves to. */
export const ASSESSMENT_CODE = 'ASSESS-01';

export const BOOKING_CATEGORIES: BookingCategory[] = [
  {
    key: 'GENERAL_SERVICING',
    title: 'General Servicing',
    description: 'Routine maintenance and service checks.',
    icon: 'wrench',
    serviceCodes: ['GEN-SERV-01'],
    approxMinutes: 90,
  },
  {
    key: 'OIL_CHANGE',
    title: 'Oil Change',
    description: 'Engine oil and oil filter service.',
    icon: 'oil',
    serviceCodes: ['OIL-01'],
    approxMinutes: 30,
  },
  {
    key: 'BATTERY',
    title: 'Battery Test / Replacement',
    description: 'Battery testing, and replacement where it is needed.',
    icon: 'battery',
    serviceCodes: ['BAT-01'],
    approxMinutes: 30,
    symptoms: [
      { code: 'BATTERY_SLOW_START', label: 'Difficult or slow to start' },
      { code: 'BATTERY_REPEATEDLY_FLAT', label: 'Battery keeps going flat' },
      { code: 'BATTERY_WARNING_LIGHT', label: 'Battery warning light' },
      { code: 'BATTERY_REPLACEMENT_REQUESTED', label: 'I want the battery replaced' },
      { code: 'NOT_SURE', label: 'Not sure' },
    ],
  },
  {
    key: 'BRAKES',
    title: 'Brake Service / Inspection',
    description: 'Brake checks, noises and pad replacement.',
    icon: 'brake',
    serviceCodes: [],
    options: [
      { key: 'inspect', label: 'Brake inspection', help: 'Have the brakes checked over.', serviceCodes: ['BRK-01'] },
      {
        key: 'pads',
        label: 'Brake pad replacement',
        help: 'You already know the pads need replacing.',
        // BRK-02 is canonical. DISC-01 is superseded and deliberately never offered.
        serviceCodes: ['BRK-02'],
      },
      {
        key: 'concern',
        label: 'Something is wrong with the brakes',
        help: 'A noise, a vibration, a warning light — we will check it and tell you what it needs.',
        serviceCodes: [],
        fallsBackToAssessment: true,
      },
    ],
    symptoms: [
      { code: 'BRAKE_NOISE', label: 'Noise when braking' },
      { code: 'BRAKE_VIBRATION', label: 'Vibration when braking' },
      { code: 'BRAKE_WARNING_LIGHT', label: 'Brake warning light' },
      { code: 'BRAKE_REDUCED_PERFORMANCE', label: 'Does not stop as well as it did' },
      { code: 'NOT_SURE', label: 'Not sure' },
    ],
  },
  {
    key: 'TIRES',
    title: 'Tire & Wheel Service',
    description: 'Rotation, alignment and tyre concerns.',
    icon: 'tire',
    serviceCodes: [],
    options: [
      { key: 'rotation', label: 'Tire rotation', serviceCodes: ['TIR-01'] },
      { key: 'alignment', label: 'Wheel alignment', serviceCodes: ['TIR-02'] },
      {
        key: 'concern',
        label: 'Something is wrong with the tyres or steering',
        help: 'Pulling, uneven wear, a vibration — we will take a look.',
        serviceCodes: [],
        fallsBackToAssessment: true,
      },
    ],
    symptoms: [
      { code: 'ALIGN_PULLS_LEFT', label: 'Pulls to the left' },
      { code: 'ALIGN_PULLS_RIGHT', label: 'Pulls to the right' },
      { code: 'ALIGN_UNEVEN_TYRE_WEAR', label: 'Uneven tyre wear' },
      { code: 'ALIGN_WHEEL_OFF_CENTRE', label: 'Steering wheel is off-centre' },
      { code: 'ALIGN_VIBRATION', label: 'Vibration while driving' },
      { code: 'NOT_SURE', label: 'Not sure' },
    ],
  },
  {
    key: 'INSPECTION',
    title: 'Vehicle Inspection',
    description: 'A thorough look over the vehicle.',
    icon: 'clipboard',
    serviceCodes: [],
    options: [
      {
        key: 'prepurchase',
        label: 'Pre-purchase inspection',
        help: 'Thinking of buying this vehicle.',
        serviceCodes: ['INSP-01'],
      },
      { key: 'brakes', label: 'Brake inspection', serviceCodes: ['BRK-01'] },
      {
        key: 'general',
        label: 'General check-over',
        help: 'Not sure what needs looking at.',
        serviceCodes: [],
        fallsBackToAssessment: true,
      },
    ],
  },
  {
    key: 'CLEANING',
    title: 'Vehicle Cleaning',
    description: 'Have the vehicle cleaned.',
    icon: 'sparkle',
    serviceCodes: ['CLEAN-01'],
    approxMinutes: 30,
  },
  {
    key: 'OTHER',
    title: 'Other / Describe My Issue',
    description: 'Not sure which service you need? Tell us what is happening with the vehicle.',
    icon: 'question',
    serviceCodes: [ASSESSMENT_CODE],
    requiresConcern: true,
    approxMinutes: 30,
  },
];

export function findCategory(key: string): BookingCategory | undefined {
  return BOOKING_CATEGORIES.find((c) => c.key === key);
}

/**
 * The service codes a selection books.
 *
 * An option that describes a problem rather than requesting work resolves to the
 * assessment service — a controlled slot in which somebody looks at the car. It
 * must never resolve to a repair: the customer said something was wrong, not what
 * was wrong, and booking a pad replacement from "there is a noise" would decide
 * the job before anyone had seen it.
 */
export function resolveServiceCodes(categoryKey: string, optionKey?: string | null): string[] {
  const category = findCategory(categoryKey);
  if (!category) return [];
  if (!category.options || category.options.length === 0) return category.serviceCodes;
  const option = category.options.find((o) => o.key === optionKey);
  if (!option) return [];
  if (option.fallsBackToAssessment || option.serviceCodes.length === 0) return [ASSESSMENT_CODE];
  return option.serviceCodes;
}

/** Must the customer describe the problem before continuing? */
export function concernRequired(categoryKey: string, optionKey?: string | null): boolean {
  const category = findCategory(categoryKey);
  if (!category) return false;
  if (category.requiresConcern) return true;
  const option = category.options?.find((o) => o.key === optionKey);
  return !!option?.fallsBackToAssessment;
}

/** True when the category needs a further choice before it can be booked. */
export function needsOption(categoryKey: string): boolean {
  const c = findCategory(categoryKey);
  return !!c?.options && c.options.length > 0;
}

/**
 * Would changing from one selection to another change the SCHEDULING?
 *
 * Used to decide whether a chosen appointment time survives an edit (§9). Only a
 * change of booked services can move the duration or the bay required; editing a
 * concern or ticking a symptom cannot, and making the customer pick their time
 * again for that would be gratuitous.
 */
export function schedulingChanged(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return true;
  const a = [...before].sort();
  const b = [...after].sort();
  return a.some((code, i) => code !== b[i]);
}
