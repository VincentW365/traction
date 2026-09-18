/**
 * CR-2026-111e — how a resource's two states are worded on screen.
 *
 * A work resource has TWO independent facts, and the API keeps them apart
 * correctly. The screens did not, because both use the word "AVAILABLE":
 *
 *   OCCUPANCY          — is something in it right now?   AVAILABLE / OCCUPIED / RESERVED
 *   OPERATIONAL STATE  — can it accept work at all?      AVAILABLE / TEMPORARILY_UNAVAILABLE
 *                                                        / MAINTENANCE / OUT_OF_SERVICE
 *
 * A bay in MAINTENANCE with nothing in it is `status: AVAILABLE` and
 * `operationalState: MAINTENANCE`. The dispatch board printed the first as a green
 * "Available" chip, so a bay nobody could use looked like the best bay on the board.
 *
 * The model is right and is not changed. What changes is that neither raw word is
 * ever printed: occupancy becomes "Available"/"In use", operational state becomes
 * "Operational"/"Maintenance", and when a resource CANNOT take work the operational
 * state leads and occupancy is demoted to a secondary line.
 *
 * Pure functions, no React, so the wording is testable without rendering anything.
 */

/** Can accept work. The API's own vocabulary (`OP_STATES`). */
export type OperationalState = 'AVAILABLE' | 'TEMPORARILY_UNAVAILABLE' | 'MAINTENANCE' | 'OUT_OF_SERVICE';
/** Something is in it right now. */
export type OccupancyState = 'AVAILABLE' | 'OCCUPIED' | 'RESERVED';

export interface Chip {
  label: string;
  /** Badge classes (background + text). */
  badge: string;
  /** A solid colour, for a dot. */
  dot: string;
  /** Left-border class for a card stripe. Written out in full because Tailwind
   *  only keeps classes it can see as literals — a composed `border-l-${x}` is
   *  purged and the stripe silently disappears. */
  border: string;
}

/**
 * The operational state, in words an advisor can act on.
 *
 * `AVAILABLE` is deliberately rendered "Operational" and never "Available" — that
 * single overloaded word is the whole defect this module exists to fix.
 */
const OPERATIONAL: Record<OperationalState, Chip> = {
  AVAILABLE: { label: 'Operational', badge: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', border: 'border-l-emerald-500' },
  TEMPORARILY_UNAVAILABLE: { label: 'Temporarily Unavailable', badge: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500', border: 'border-l-amber-500' },
  MAINTENANCE: { label: 'Maintenance', badge: 'bg-orange-50 text-orange-700', dot: 'bg-orange-500', border: 'border-l-orange-500' },
  OUT_OF_SERVICE: { label: 'Out of Service', badge: 'bg-red-50 text-red-700', dot: 'bg-red-500', border: 'border-l-red-500' },
};

const OCCUPANCY: Record<OccupancyState, Chip> = {
  AVAILABLE: { label: 'Available', badge: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', border: 'border-l-emerald-500' },
  OCCUPIED: { label: 'In use', badge: 'bg-blue-50 text-blue-700', dot: 'bg-blue-500', border: 'border-l-blue-500' },
  RESERVED: { label: 'Reserved', badge: 'bg-indigo-50 text-indigo-700', dot: 'bg-indigo-500', border: 'border-l-indigo-500' },
};

const UNKNOWN: Chip = { label: 'Unknown', badge: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400', border: 'border-l-slate-400' };

export function operationalChip(state: string | null | undefined): Chip {
  return OPERATIONAL[(state ?? 'AVAILABLE') as OperationalState] ?? UNKNOWN;
}

export function occupancyChip(state: string | null | undefined): Chip {
  return OCCUPANCY[(state ?? 'AVAILABLE') as OccupancyState] ?? UNKNOWN;
}

/** Does the GRADED state alone say this resource can take work? */
export function canReceiveWork(state: string | null | undefined): boolean {
  return (state ?? 'AVAILABLE') === 'AVAILABLE';
}

/**
 * The two ways a resource gets marked down, reconciled.
 *
 * `POST /resources/:id/status` sets a graded state (MAINTENANCE, OUT_OF_SERVICE…).
 * `POST /resources/:id/operational-status` — the Dispatch Board's own "Mark down"
 * button — flips the `isOperational` boolean and leaves the graded state at
 * AVAILABLE. Reading the graded word alone would therefore show a bay marked down
 * from the board as green and "Available": the original defect, by the commonest path.
 *
 * So both signals count, and the boolean-only case is described honestly as
 * "Temporarily Unavailable" rather than inventing a reason nobody gave.
 */
export function effectiveOperationalState(isOperational: boolean | null | undefined, state: string | null | undefined): OperationalState {
  const graded = (state ?? 'AVAILABLE') as OperationalState;
  if (isOperational === false && graded === 'AVAILABLE') return 'TEMPORARILY_UNAVAILABLE';
  return graded;
}

export interface ResourceStatusView {
  /** The chip that leads: the operational state whenever the resource cannot take work. */
  lead: Chip;
  /** The quieter second line. */
  secondary: { label: string; muted: boolean };
  /** Left-border class for the card. */
  stripe: string;
  /** True when the operational state is leading because work cannot be taken. */
  blocked: boolean;
}

/**
 * Decide what leads on a resource card.
 *
 * When a resource cannot take work, the operational state leads and occupancy drops
 * to "Not currently occupied" — phrased so it reads as a fact about the bay being
 * empty, never as an invitation to use it. When it CAN take work, occupancy leads,
 * because that is the only question left.
 */
export function resourceStatusView(input: {
  /** The boolean the Dispatch Board's "Mark down" button writes. */
  isOperational?: boolean | null;
  /** The graded word `POST /resources/:id/status` writes. */
  operationalState?: string | null;
  /** OCCUPANCY: AVAILABLE / OCCUPIED / RESERVED. */
  occupancy?: string | null;
}): ResourceStatusView {
  const { isOperational, operationalState, occupancy } = input;
  const effective = effectiveOperationalState(isOperational, operationalState);
  const op = operationalChip(effective);
  const occ = occupancyChip(occupancy);

  if (!canReceiveWork(effective)) {
    return {
      lead: op,
      secondary: {
        label: (occupancy ?? 'AVAILABLE') === 'OCCUPIED' ? 'Still has a vehicle in it' : 'Not currently occupied',
        muted: true,
      },
      stripe: op.border,
      blocked: true,
    };
  }

  return { lead: occ, secondary: { label: op.label, muted: true }, stripe: occ.border, blocked: false };
}
