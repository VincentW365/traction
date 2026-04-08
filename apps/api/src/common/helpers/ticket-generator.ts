import { PrismaClient } from '@prisma/client';
import { toZonedTime } from 'date-fns-tz';
import { format } from 'date-fns';

/**
 * Generates a site-scoped daily ticket number and check-in sequence.
 *
 * Format: QTK-<SITE_CODE>-<YYYYMMDD>-<SEQ>
 * - SITE_CODE: from the site's `code` field (e.g. "BERT-01")
 * - YYYYMMDD: site-local date (not UTC)
 * - SEQ: zero-padded 4-digit daily sequence, site-scoped
 *
 * The sequence is generated via a MAX+1 query within a serializable
 * transaction to avoid race conditions.
 *
 * IMPORTANT: This function must be called inside an existing Prisma
 * interactive transaction ($transaction callback). Pass the transaction
 * client (`tx`) as the first argument, NOT the root PrismaClient.
 */
export async function generateTicketNumber(
  prisma: PrismaClient,
  siteId: string,
  siteCode: string,
  siteTimezone: string,
): Promise<{ ticketNumber: string; checkinSequence: number }> {
  // Determine the current date in the site's local timezone
  const now = new Date();
  const zonedNow = toZonedTime(now, siteTimezone);
  const dateStr = format(zonedNow, 'yyyyMMdd');

  // Get the next sequence number for this site + day.
  // The raw query computes COALESCE(MAX(qt.checkin_sequence), 0) + 1
  // scoped to the site and the current date in the database timezone.
  const result = await (prisma as any).$queryRaw<
    { next_seq: number }[]
  >`
    SELECT COALESCE(MAX(qt.checkin_sequence), 0) + 1 AS next_seq
    FROM queue_tickets qt
    JOIN service_visits sv ON qt.service_visit_id = sv.id
    WHERE sv.site_id = ${siteId}::uuid
      AND qt.generated_at::date = CURRENT_DATE
  `;

  const checkinSequence = Number(result[0].next_seq);
  const seqStr = String(checkinSequence).padStart(4, '0');
  const ticketNumber = `QTK-${siteCode}-${dateStr}-${seqStr}`;

  return { ticketNumber, checkinSequence };
}
