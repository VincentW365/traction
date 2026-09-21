/**
 * CR-2026-113 — one way to decide what is, and is not, a customer email address.
 *
 * The import put the literal text "N/A" in the email column of 3,649 customers.
 * A placeholder that behaves like an address is worse than an empty column: it
 * makes "we can reach this customer" read as true in every count and on every
 * screen that checks presence rather than validity, and the falsehood is only
 * discovered when a message fails to arrive.
 *
 * The rule, applied at every write boundary:
 *   blank or a recognised placeholder → NULL      (missing, not an error)
 *   anything else                     → must be a valid address, or the write
 *                                       is rejected with a message naming why
 *
 * Pure and dependency-free so it can be unit-tested and reused by the importer,
 * the services and the DTO layer without dragging any of them together.
 */

/**
 * Text people type to mean "none". Compared trimmed and lower-cased, so " N/A "
 * and "n/a" are both caught. Nothing here contains "@", so a real address can
 * never match: this list can only ever turn non-addresses into NULL.
 */
export const EMAIL_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'n/a',
  'na',
  'n.a.',
  'none',
  'null',
  'nil',
  'nal',
  '-',
  '--',
  '.',
  'no email',
  'noemail',
  'no e-mail',
  'unknown',
  'x',
]);

/** Mirrors the notification engine's server-side check (template-engine.ts). */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isPlaceholderEmail(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '' || EMAIL_PLACEHOLDERS.has(v);
}

export function isValidCustomerEmail(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim();
  if (v.length > 254 || isPlaceholderEmail(v)) return false;
  return EMAIL_SHAPE.test(v);
}

export class InvalidCustomerEmailError extends Error {
  constructor(readonly value: string) {
    super(
      `"${value}" is not a valid email address. Enter a full address such as name@example.com, or leave it blank if the customer has not given one.`,
    );
    this.name = 'InvalidCustomerEmailError';
  }
}

/**
 * The value to STORE for a customer email.
 *
 * - `undefined` in → `undefined` out: the caller is not changing the field, and
 *   a partial update must never blank an address it was not asked to touch.
 * - blank / placeholder → `null`: the customer has not given one. Not an error;
 *   the screens already say "No customer email address is recorded."
 * - anything else → trimmed, lower-cased, and validated. Lower-casing is safe
 *   for storage and makes duplicate detection work; the local part is
 *   technically case-sensitive but no mail system in practice relies on it.
 *
 * @throws InvalidCustomerEmailError when the value is neither blank nor valid.
 */
export function normalizeCustomerEmail(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (isPlaceholderEmail(trimmed)) return null;
  const normalized = trimmed.toLowerCase();
  if (!EMAIL_SHAPE.test(normalized) || normalized.length > 254) {
    throw new InvalidCustomerEmailError(trimmed);
  }
  return normalized;
}

/**
 * The same normalisation for a bulk path (the customer importer), where one bad
 * row must not abort the run: an invalid address is reported and stored as NULL
 * rather than thrown, because an import that stops halfway is worse than an
 * import that tells you which rows to look at.
 */
export function normalizeImportedEmail(raw: string | null | undefined): {
  value: string | null;
  rejected: string | null;
} {
  try {
    const value = normalizeCustomerEmail(raw);
    return { value: value ?? null, rejected: null };
  } catch {
    return { value: null, rejected: (raw ?? '').trim() };
  }
}
