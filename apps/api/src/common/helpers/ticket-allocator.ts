import { PrismaClient } from '@prisma/client';
import {
  buildTicketIdentifiers,
  deriveLocationCode,
  isValidLocationCode,
  resolveBusinessDate,
  type TicketIdentifiers,
} from './ticket-generator-v2';

/**
 * CR-2026-089 — allocate the next queue ticket number for a site and day.
 *
 * The sequence comes from a single atomic statement:
 *
 *   INSERT ... VALUES (site, date, 1)
 *   ON CONFLICT (site_id, business_date)
 *   DO UPDATE SET last_sequence = last_sequence + 1
 *   RETURNING last_sequence
 *
 * Postgres serialises concurrent writers on the conflicting row, so fifty
 * simultaneous check-ins get fifty distinct numbers with no lost updates and no
 * retry loop. This replaces a `SELECT MAX(seq)+1` that leaned entirely on
 * SERIALIZABLE isolation and, because Prisma does not retry, surfaced a raw 500
 * to whichever front-desk user lost the race.
 *
 * The allocation is intentionally NOT reversible. A cancelled, voided or no-show
 * ticket keeps its number and the counter never rewinds — reusing a number would
 * make two different visits indistinguishable in the day's records.
 *
 * Must run inside the caller's transaction so the number and the ticket row are
 * committed together; a failed check-in must not burn a sequence.
 */
export async function allocateTicketIdentifiers(
  tx: PrismaClient,
  site: { id: string; code: string; timezone: string | null; ticketCode?: string | null },
  now: Date = new Date(),
): Promise<TicketIdentifiers> {
  const timezone = site.timezone ?? 'America/Jamaica';
  const businessDate = resolveBusinessDate(now, timezone);

  // An explicit code always wins; otherwise derive one so a site that has never
  // been configured still issues sensible tickets from day one.
  const locationCode = isValidLocationCode(site.ticketCode)
    ? site.ticketCode!
    : deriveLocationCode(site.code);

  const rows = await (tx as any).$queryRaw<{ last_sequence: number }[]>`
    INSERT INTO daily_ticket_counters (site_id, business_date, last_sequence, created_at, updated_at)
    VALUES (${site.id}::uuid, ${businessDate}::date, 1, now(), now())
    ON CONFLICT (site_id, business_date)
    DO UPDATE SET
      last_sequence = daily_ticket_counters.last_sequence + 1,
      updated_at = now()
    RETURNING last_sequence
  `;

  const dailySequence = Number(rows[0].last_sequence);
  return buildTicketIdentifiers(locationCode, businessDate, dailySequence);
}
