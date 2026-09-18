/**
 * CR-2026-108 Stage 2 — the internal availability decision model.
 *
 * WHY THIS EXISTS
 * The engine used to answer `available: boolean`, and slots it rejected for
 * timing reasons were not returned at all: a slot before the minimum notice was
 * `continue`d, and everything after the customer cutoff ended the loop. So when
 * a customer said "there was nothing on Tuesday", nobody could say why — the
 * information had never been computed, let alone stored. That is the gap this
 * closes: every candidate slot now carries the reason it was or was not offered.
 *
 * WHAT IT IS NOT
 * This model is INTERNAL. It names capacity numbers, rule values and (from
 * Stage 5) resource facts. None of that may reach the public booking page:
 * together it would expose how full the shop is, how it is staffed, and enough
 * structure to probe the schedule. `toCustomerAvailability` is the only way the
 * public API sees any of it, and it deliberately projects down to exactly the
 * shape /book already consumed — nothing added, nothing leaked.
 *
 * Admin and testing tools (Stage 3's simulator) consume the rich form directly.
 */

/**
 * Why a slot is, or is not, offered.
 *
 * The full vocabulary is declared here even though later stages emit some of it,
 * so that consumers, tests and the simulator UI can be written against a stable
 * set rather than growing string literals stage by stage. Each entry says which
 * stage produces it.
 */
export type SlotReasonCode =
  /** Offered. */
  | 'AVAILABLE'
  // --- timing (Stage 2) ---
  /** Earlier than `booking_min_notice_minutes` from now. */
  | 'MINIMUM_NOTICE'
  /** In the past. Distinct from MINIMUM_NOTICE, which is a policy, not a fact. */
  | 'PAST'
  /** After `customer_booking_latest_start` for this audience. */
  | 'CUSTOMER_LATEST_START'
  /** The job would not finish before the site closes. */
  | 'OUTSIDE_OPENING_HOURS'
  // --- day-level (Stage 2) ---
  /** The site does not open this weekday. */
  | 'CLOSED_WEEKDAY'
  /** Listed in `booking_closed_dates`. */
  | 'CLOSED_DATE'
  /** Today, and `booking_same_day_allowed` is off. */
  | 'SAME_DAY_NOT_ALLOWED'
  /** Beyond `booking_advance_window_days`. */
  | 'OUTSIDE_ADVANCE_WINDOW'
  // --- capacity (Stage 2 = FIXED; Stage 5 adds the rest) ---
  /** The configured concurrent-position ceiling is already met at this time. */
  | 'FIXED_CAPACITY_REACHED'
  /** Positions remain, but they are held back for walk-ins/overruns (Stage 5). */
  | 'ONLINE_RESERVE_REACHED'
  /** No capacity-contributing resource is free for the whole job (Stage 5). */
  | 'RESOURCE_CAPACITY_REACHED'
  /** The service needs a specific bay/resource type and none is available (Stage 5). */
  | 'REQUIRED_RESOURCE_UNAVAILABLE'
  /** No available resource supports this vehicle's class (Stage 5). */
  | 'VEHICLE_CLASS_NOT_SUPPORTED'
  /**
   * Stage 5C — not enough resource configuration exists to answer. Deliberately
   * NOT a kind of "no": a pool of zero because nobody has classified the bays is
   * a fact about the spreadsheet, and reporting it as a capacity limit would make
   * an unfinished inventory look like an operational constraint.
   */
  | 'RESOURCE_CONFIGURATION_INCOMPLETE'
  // --- service/booking rules (Stage 4 / confirm-time) ---
  /** The service is not marked bookable online (Stage 4). */
  | 'SERVICE_NOT_BOOKABLE_ONLINE'
  /** This vehicle already has a booking that day (raised on confirm). */
  | 'DUPLICATE_VEHICLE_BOOKING'
  /** `booking_enabled` is off. */
  | 'BOOKING_DISABLED';

/** Reason codes a customer-facing surface may never be told. */
export const OPERATIONAL_REASON_CODES: readonly SlotReasonCode[] = [
  'FIXED_CAPACITY_REACHED',
  'ONLINE_RESERVE_REACHED',
  'RESOURCE_CAPACITY_REACHED',
  'REQUIRED_RESOURCE_UNAVAILABLE',
  'VEHICLE_CLASS_NOT_SUPPORTED',
  'RESOURCE_CONFIGURATION_INCOMPLETE',
] as const;

/** Capacity arithmetic behind one slot decision. Internal only. */
export interface SlotCapacity {
  /** Peak concurrent bookings already overlapping this slot. */
  before: number;
  /** What that peak would become if this booking were placed. */
  after: number;
  /** The ceiling applied (FIXED mode: the configured concurrent positions). */
  limit: number;
  /** Positions withheld from online booking (Stage 5; 0 until then). */
  reserved?: number;
  /** Capacity derived from resources, when the model is resource-aware (Stage 5). */
  resourceCapacity?: number | null;
}

export interface SlotDecision {
  startAt: string;
  endAt: string;
  available: boolean;
  reasonCode: SlotReasonCode;
  /** Planned length of the booking being placed, in minutes. */
  plannedMinutes: number;
  capacity: SlotCapacity;
  /**
   * The rule or configuration that decided it, when one did — e.g.
   * `booking_min_notice_minutes=120`. Free-form and for humans: this is what the
   * simulator shows an analyst so they can go and change the right setting.
   */
  rule?: string;
  /** Anything else worth showing in diagnostics. Never projected to customers. */
  diagnostics?: Record<string, unknown>;
}

export interface DayDecision {
  date: string;
  /** True when the site offers nothing at all this day. */
  closed: boolean;
  /** Why the day is closed, when it is. */
  reasonCode?: SlotReasonCode;
  slots: SlotDecision[];
  availableCount: number;
}

export interface AvailabilityDecision {
  nextAvailable: SlotDecision | null;
  days: DayDecision[];
}

// ---------------------------------------------------------------------------
// Customer-safe projection
// ---------------------------------------------------------------------------

/** Exactly what /book consumed before this CR. Deliberately unchanged. */
export interface CustomerSlot {
  startAt: string;
  endAt: string;
  available: boolean;
}

export interface CustomerDayAvailability {
  date: string;
  closed: boolean;
  slots: CustomerSlot[];
  availableCount: number;
}

export interface CustomerAvailability {
  nextAvailable: CustomerSlot | null;
  days: CustomerDayAvailability[];
}

/**
 * Project an internal decision down to what a customer may see.
 *
 * Two rules, both deliberate:
 *
 *  1. **No reason codes, no capacity, no rules, no diagnostics.** A customer is
 *     told a time is unavailable, never that the shop is full, how full, which
 *     bay is missing or which policy stopped them. Knowing *why* would let anyone
 *     map the workshop's load and staffing from a public page.
 *
 *  2. **Slots rejected on timing are omitted entirely**, exactly as before —
 *     a past slot or one inside the notice period is not "unavailable", it was
 *     never a candidate, and listing it as greyed-out would be noise on a phone.
 *     Capacity-blocked slots ARE listed (greyed out) because the customer needs
 *     to see the shape of the day to pick another time.
 */
export function toCustomerAvailability(decision: AvailabilityDecision): CustomerAvailability {
  const days = decision.days.map((d) => {
    const slots = d.slots.filter(isCustomerVisible).map(toCustomerSlot);
    return {
      date: d.date,
      closed: d.closed,
      slots,
      availableCount: slots.filter((s) => s.available).length,
    };
  });
  return {
    nextAvailable: decision.nextAvailable ? toCustomerSlot(decision.nextAvailable) : null,
    days,
  };
}

const TIMING_ONLY: readonly SlotReasonCode[] = [
  'MINIMUM_NOTICE',
  'PAST',
  'CUSTOMER_LATEST_START',
  'OUTSIDE_OPENING_HOURS',
  'OUTSIDE_ADVANCE_WINDOW',
];

/** A slot the customer should see at all (offered, or shown blocked). */
export function isCustomerVisible(s: SlotDecision): boolean {
  return s.available || !TIMING_ONLY.includes(s.reasonCode);
}

function toCustomerSlot(s: SlotDecision): CustomerSlot {
  // Constructed field-by-field on purpose: spreading would leak every future
  // diagnostic anyone adds to SlotDecision straight onto the public page.
  return { startAt: s.startAt, endAt: s.endAt, available: s.available };
}
