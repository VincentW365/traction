/**
 * CR-2026-105c — booking reference + manage-link token helpers.
 *
 * Reference `BK-{LOC}-{YYMMDD}-{SEQ}` (e.g. BK-B01-260911-003): the queue-ticket
 * v2 builders for location code + business date, and the same atomic
 * INSERT … ON CONFLICT DO UPDATE … RETURNING allocation against a dedicated
 * counter table, run inside the caller's transaction so a failed booking never
 * burns a number. Never rewound.
 *
 * The manage token is 24 random bytes (base64url) handed to the customer once;
 * only its sha256 is stored, so a database read never yields a usable link.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  deriveLocationCode,
  formatBusinessDateCompact,
  isValidLocationCode,
  resolveBusinessDate,
} from '../../common/helpers/ticket-generator-v2';

export const BOOKING_REFERENCE_PREFIX = 'BK';
export const BOOKING_REFERENCE_PATTERN = /^BK-[A-Z0-9]{2,4}-\d{6}-\d{3,}$/;

export async function allocateBookingReference(
  tx: Prisma.TransactionClient,
  site: { id: string; code: string; timezone: string | null; ticketCode?: string | null },
  now: Date = new Date(),
): Promise<string> {
  const timezone = site.timezone ?? 'America/Jamaica';
  const businessDate = resolveBusinessDate(now, timezone);
  const locationCode = isValidLocationCode(site.ticketCode) ? site.ticketCode! : deriveLocationCode(site.code);

  const rows = await tx.$queryRaw<{ last_sequence: number }[]>`
    INSERT INTO daily_booking_counters (site_id, business_date, last_sequence, created_at, updated_at)
    VALUES (${site.id}::uuid, ${businessDate}::date, 1, now(), now())
    ON CONFLICT (site_id, business_date)
    DO UPDATE SET
      last_sequence = daily_booking_counters.last_sequence + 1,
      updated_at = now()
    RETURNING last_sequence
  `;
  const seq = Number(rows[0].last_sequence);
  return `${BOOKING_REFERENCE_PREFIX}-${locationCode}-${formatBusinessDateCompact(businessDate)}-${String(seq).padStart(3, '0')}`;
}

export function generateManageToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashManageToken(token) };
}

export function hashManageToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Show only the last four characters of a plate (customer status-page convention). */
export function maskPlate(plate: string | null | undefined): string {
  const p = (plate ?? '').trim();
  return p.length > 4 ? `***${p.slice(-4)}` : p;
}

/** Show only the last four digits of a phone. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length > 4 ? `••• ${digits.slice(-4)}` : digits;
}

/** Digits only; the last seven identify a Jamaican number regardless of formatting. */
export function phoneMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = (a ?? '').replace(/\D/g, '');
  const db = (b ?? '').replace(/\D/g, '');
  if (da.length < 7 || db.length < 7) return false;
  return da.slice(-7) === db.slice(-7);
}

/** The vehicleCode convention (`SC` + plate stripped/uppercased) — see vehicles.service. */
export function vehicleCodeForPlate(plate: string): string {
  return `SC${plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
}
