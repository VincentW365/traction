/**
 * Recommendation Calculator — Pure Functions
 *
 * All calculations are deterministic and side-effect-free.
 * Driving profile selects between normal and severe intervals.
 */

export type DrivingProfileInput = 'NORMAL' | 'SEVERE';

export interface PostServiceInput {
  currentOdometer: number;
  serviceDate: Date;
  intervalMiles: number | null;
  intervalMonths: number | null;
  drivingProfile: DrivingProfileInput;
}

export interface PostServiceResult {
  basisOdometer: number;
  basisDate: Date;
  nextDueOdometer: number | null;
  nextDueDate: Date | null;
  dueNowFlag: boolean;
}

export interface AdvisoryInput {
  currentOdometer: number | null;
  lastServiceOdometer: number | null;
  lastServiceDate: Date | null;
  intervalMiles: number | null;
  intervalMonths: number | null;
  drivingProfile: DrivingProfileInput;
}

export interface AdvisoryResult {
  basisOdometer: number | null;
  basisDate: Date | null;
  nextDueOdometer: number | null;
  nextDueDate: Date | null;
  dueNowFlag: boolean;
  isDeterminable: boolean;
}

/**
 * Add months to a date, returning a new Date instance.
 */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + months);
  return result;
}

/**
 * Calculate next-due recommendation after a service has been completed.
 *
 * The basis is always the service just performed, so we know the exact
 * odometer and date. dueNowFlag is always false because service was just done.
 */
export function calculatePostService(input: PostServiceInput): PostServiceResult {
  const { currentOdometer, serviceDate, intervalMiles, intervalMonths } = input;

  const nextDueOdometer =
    intervalMiles != null ? currentOdometer + intervalMiles : null;

  const nextDueDate =
    intervalMonths != null ? addMonths(serviceDate, intervalMonths) : null;

  return {
    basisOdometer: currentOdometer,
    basisDate: serviceDate,
    nextDueOdometer,
    nextDueDate,
    dueNowFlag: false,
  };
}

/**
 * Calculate an advisory recommendation for a vehicle that may or may not
 * have prior service history.
 *
 * If lastServiceOdometer is unknown, isDeterminable = false and all
 * next-due fields are null — the system cannot safely predict when service
 * is next needed without a baseline.
 */
export function calculateAdvisory(input: AdvisoryInput): AdvisoryResult {
  const {
    currentOdometer,
    lastServiceOdometer,
    lastServiceDate,
    intervalMiles,
    intervalMonths,
  } = input;

  // Cannot determine recommendation without a known service baseline
  if (lastServiceOdometer == null && lastServiceDate == null) {
    return {
      basisOdometer: null,
      basisDate: null,
      nextDueOdometer: null,
      nextDueDate: null,
      dueNowFlag: false,
      isDeterminable: false,
    };
  }

  const nextDueOdometer =
    lastServiceOdometer != null && intervalMiles != null
      ? lastServiceOdometer + intervalMiles
      : null;

  const nextDueDate =
    lastServiceDate != null && intervalMonths != null
      ? addMonths(lastServiceDate, intervalMonths)
      : null;

  // Determine if service is due now
  const odometerDue =
    nextDueOdometer != null &&
    currentOdometer != null &&
    currentOdometer >= nextDueOdometer;

  const dateDue = nextDueDate != null && new Date() >= nextDueDate;

  const dueNowFlag = odometerDue || dateDue;

  return {
    basisOdometer: lastServiceOdometer,
    basisDate: lastServiceDate,
    nextDueOdometer,
    nextDueDate,
    dueNowFlag,
    isDeterminable: true,
  };
}
