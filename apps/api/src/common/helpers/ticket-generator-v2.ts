import { toZonedTime } from 'date-fns-tz';
import { format } from 'date-fns';

/**
 * CR-2026-089 — queue ticket numbering v2.
 *
 *   Full reference    B01-260820-003     {LOCATION}-{YYMMDD}-{SEQUENCE}
 *   Customer number   B01-003            {LOCATION}-{SEQUENCE}
 *   Display emphasis  003
 *
 * Replaces `QTK-BERT-01-20260820-0003`. "QTK" and "BERT" identified nothing the
 * application did not already know, and the four-digit year plus extra padding
 * cost width on a lobby screen and on a technician's phone for no benefit.
 *
 * Two problems with the previous generator are fixed here:
 *
 *  1. **It was a read-max-then-increment.** `SELECT MAX(seq)+1` with no lock,
 *     relying entirely on the caller running SERIALIZABLE. That is technically
 *     safe but practically poor — Prisma does not retry, so two people checking
 *     in at the same moment gave one of them a raw 500. The sequence now comes
 *     from a single atomic upsert-and-increment, so concurrency is handled where
 *     it arises rather than by isolation level.
 *
 *  2. **The day boundary disagreed with itself.** The printed date used the
 *     site's timezone while the SQL bucketed on `CURRENT_DATE`, which resolves in
 *     the database session's timezone. With a UTC database and a Jamaica site
 *     those differ for five hours every evening, so the printed date could roll
 *     over while the sequence had not, or vice versa. The business date is now
 *     computed once, in the site's timezone, and used for both.
 */

/** Minimum width; a shop that passes 999 in a day simply gets four digits. */
const SEQUENCE_PAD = 3;

export interface TicketIdentifiers {
  /** Full operational reference, e.g. `B01-260820-003`. */
  ticketReference: string;
  /** Customer-facing number, e.g. `B01-003`. */
  displayTicketNumber: string;
  /** The location code as at issue. */
  locationCodeSnapshot: string;
  /** Jamaica business date, midnight UTC of that calendar day. */
  businessDate: Date;
  dailySequence: number;
}

/**
 * The site-local calendar day, as a date-only value.
 *
 * Returned at UTC midnight of that day so it round-trips through a Postgres
 * `DATE` column unchanged. This is what makes the sequence reset at Jamaica
 * midnight rather than the server's.
 */
export function resolveBusinessDate(now: Date, siteTimezone: string): Date {
  const zoned = toZonedTime(now, siteTimezone);
  return new Date(`${format(zoned, 'yyyy-MM-dd')}T00:00:00.000Z`);
}

/** `YYMMDD` for the reference, from the same business date used for the sequence. */
export function formatBusinessDateCompact(businessDate: Date): string {
  return format(
    new Date(
      businessDate.getUTCFullYear(),
      businessDate.getUTCMonth(),
      businessDate.getUTCDate(),
    ),
    'yyMMdd',
  );
}

/**
 * Assemble the identifiers. Pure — the sequence is allocated by the caller.
 *
 * Padding is a MINIMUM, not a limit: sequence 1000 renders as `1000`, never
 * wrapping back to 001 and never being rejected.
 */
export function buildTicketIdentifiers(
  locationCode: string,
  businessDate: Date,
  dailySequence: number,
): TicketIdentifiers {
  const seq = String(dailySequence).padStart(SEQUENCE_PAD, '0');
  const code = locationCode.toUpperCase();
  const datePart = formatBusinessDateCompact(businessDate);

  return {
    ticketReference: `${code}-${datePart}-${seq}`,
    displayTicketNumber: `${code}-${seq}`,
    locationCodeSnapshot: code,
    businessDate,
    dailySequence,
  };
}

/**
 * A location code is uppercase, 2-4 alphanumerics, no spaces.
 * Validated before activation so a bad code can never reach a printed ticket.
 */
export const LOCATION_CODE_PATTERN = /^[A-Z0-9]{2,4}$/;

export function isValidLocationCode(code: string | null | undefined): boolean {
  return !!code && LOCATION_CODE_PATTERN.test(code);
}

/**
 * Derive a fallback location code from a site code, for a site that has not been
 * given an explicit one yet. `BERT-01` -> `B01`; anything unusable falls back to
 * the first alphanumerics available.
 *
 * This exists so the scheme works on day one without a manual data step. It is a
 * default, not a rule — an administrator can set any valid code, and once tickets
 * are issued under it they keep it forever.
 */
export function deriveLocationCode(siteCode: string): string {
  const cleaned = siteCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length === 0) return 'B01';

  // "BERT01" -> first letter + the trailing digits, e.g. "B01".
  const letters = cleaned.replace(/[0-9]/g, '');
  const digits = cleaned.replace(/[^0-9]/g, '');
  if (letters.length > 0 && digits.length > 0) {
    const candidate = letters[0] + digits.slice(-2);
    if (isValidLocationCode(candidate)) return candidate;
  }

  const truncated = cleaned.slice(0, 4);
  // A single-character site code would otherwise produce an invalid location code
  // and a malformed ticket reference. Pad rather than fail: this is a fallback for
  // a site nobody has configured yet, and it must always yield something usable.
  return isValidLocationCode(truncated) ? truncated : truncated.padEnd(2, '1');
}

/**
 * Normalise user input for searching, so a reference typed with or without
 * hyphens (and in any case) resolves the same way.
 *
 * Deliberately used ONLY for search. Database uniqueness stays on the exact
 * stored string — weakening a constraint to make a text box friendlier would be
 * the wrong trade.
 */
export function normaliseTicketSearch(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}
