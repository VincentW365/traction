/**
 * CR-2026-106 — ONE parser for everything staff type into a search box.
 *
 * Root cause it fixes (docs/121 §C1): the picker endpoints ran the whole string
 * "Vincent Wilson" as a single `contains` against each column, so a full name
 * never matched; phones were compared in whichever format happened to be stored;
 * plates only matched through a vehicle-code side door. Every search path now
 * derives its predicates from this one normalised view of the query.
 *
 * Pure — no I/O — so the semantics are unit-testable and identical everywhere.
 */

/** Digits only (keeps a leading country code). Canonical storage form for Customer.phone. */
export function normalizePhone(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/** Upper-case, alphanumeric only. Canonical storage form for Vehicle.plateNumber. */
export function normalizePlate(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Storage normalisation for a customer phone: digits when the input carries a
 * real number; the trimmed input otherwise, so a deliberate placeholder such as
 * "N/A" survives instead of becoming an empty string.
 */
export function phoneForStorage(input: string | null | undefined): string {
  const raw = (input ?? '').trim();
  const digits = normalizePhone(raw);
  return digits.length > 0 ? digits : raw;
}

/** Storage normalisation for a plate: stripped + upper-cased (matches the vehicleCode rule). */
export function plateForStorage(input: string | null | undefined): string {
  const p = normalizePlate(input);
  return p.length > 0 ? p : (input ?? '').trim();
}

export interface ParsedSearch {
  /** Trimmed, single-spaced input. */
  raw: string;
  /** Whitespace-split tokens. */
  tokens: string[];
  /** Tokens that contain at least one letter — the ones that can be part of a name. */
  nameTokens: string[];
  /** Every digit in the input, in order. */
  digits: string;
  /** Last 7 digits — the local subscriber number, prefix-insensitive (+1 876 / 876 / 1876). */
  phoneTail: string;
  /** Separator-insensitive upper-case form for plate / VIN / code comparison. */
  code: string;
  /** True when the input reads as a telephone number (digits with phone punctuation only, ≥ 7 digits). */
  looksLikePhone: boolean;
  /** True when the input contains an @ — treat as an email fragment. */
  looksLikeEmail: boolean;
}

export const PHONE_TAIL_DIGITS = 7;

export function parseSearchQuery(input: string | null | undefined): ParsedSearch {
  const raw = (input ?? '').trim().replace(/\s+/g, ' ');
  const tokens = raw ? raw.split(' ') : [];
  const digits = normalizePhone(raw);
  const looksLikePhone = raw.length > 0 && /^[\d\s()+.\-]+$/.test(raw) && digits.length >= PHONE_TAIL_DIGITS;
  return {
    raw,
    tokens,
    nameTokens: tokens.filter((t) => /[A-Za-z]/.test(t)),
    digits,
    phoneTail: digits.slice(-PHONE_TAIL_DIGITS),
    code: normalizePlate(raw),
    looksLikePhone,
    looksLikeEmail: raw.includes('@'),
  };
}
