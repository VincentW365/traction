/**
 * CR-2026-096 — safe placeholder rendering for customer notification templates.
 *
 * Templates are plain text with `{{placeholder}}` tokens from a fixed allow-list —
 * no expressions, no executable content. Rendering substitutes placeholders that
 * have real values, reports the ones that don't, and tidies the surrounding text
 * so a missing optional value (e.g. vehicle year) never produces broken wording
 * like "your  Honda" or "your null null".
 */

export const ALLOWED_PLACEHOLDERS = [
  'customerFirstName',
  'customerFullName',
  'vehicleYear',
  'vehicleMake',
  'vehicleModel',
  'vehicleDescription',
  'registrationNumber',
  'ticketDisplayNumber',
  'serviceDueDetails',
  'serviceDueDate',
  'serviceDueMileage',
  'lastServiceDate',
  'currentMileage',
  'pickupDetails',
  'staffEditableUpdate',
  'businessName',
  'siteName',
] as const;

export type PlaceholderKey = (typeof ALLOWED_PLACEHOLDERS)[number];
export type TemplateData = Partial<Record<PlaceholderKey, string | number | null | undefined>>;

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** All `{{...}}` tokens appearing in a template body. */
export function findPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/** Tokens in a template that are NOT on the allow-list (rejected at template save). */
export function findDisallowedPlaceholders(text: string): string[] {
  return findPlaceholders(text).filter(
    (p) => !(ALLOWED_PLACEHOLDERS as readonly string[]).includes(p),
  );
}

export interface RenderResult {
  text: string;
  /** Placeholders left in the text because no value was available. */
  unresolved: string[];
}

/**
 * Substitute allow-listed placeholders that have non-empty values. Placeholders
 * without a value are REMOVED from the text (reported in `unresolved`) and the
 * surrounding whitespace/punctuation is tidied — the customer must never see
 * `{{vehicleYear}}` or a double space where the year would have been.
 */
export function renderTemplate(template: string, data: TemplateData): RenderResult {
  const unresolved: string[] = [];
  let text = template.replace(PLACEHOLDER_RE, (_whole, key: string) => {
    const value = (data as Record<string, unknown>)[key];
    if (value === null || value === undefined || String(value).trim() === '') {
      if (!unresolved.includes(key)) unresolved.push(key);
      return '';
    }
    return String(value).trim();
  });
  text = tidyWhitespace(text);
  return { text, unresolved };
}

/** Collapse artefacts of removed placeholders: doubled spaces, space-before-comma, empty (). */
function tidyWhitespace(text: string): string {
  return text
    .replace(/\(\s*\)/g, '') // empty brackets from a missing registration
    .replace(/[ \t]+([,.;!?])/g, '$1') // "Corolla , registration" → "Corolla, registration"
    .replace(/[ \t]{2,}/g, ' ') // doubled spaces where a value vanished
    .replace(/^[ \t]+|[ \t]+$/gm, '') // per-line trim (keeps email line breaks)
    .replace(/\n{3,}/g, '\n\n') // collapse runs of blank lines
    .trim();
}

/** `{{...}}` tokens still present in a FINAL message — sending must be blocked. */
export function findUnresolvedInFinal(text: string): string[] {
  return findPlaceholders(text);
}

/**
 * "2020 Toyota Corolla" from whatever vehicle facts exist; falls back to
 * "vehicle <registration>" and finally "vehicle" — never null-null wording.
 */
export function buildVehicleDescription(vehicle: {
  modelYear?: number | null;
  make?: string | null;
  model?: string | null;
  plateNumber?: string | null;
}): string {
  const parts = [vehicle.modelYear, vehicle.make, vehicle.model]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .map((v) => String(v).trim());
  if (parts.length > 0) return parts.join(' ');
  if (vehicle.plateNumber?.trim()) return `vehicle ${vehicle.plateNumber.trim()}`;
  return 'vehicle';
}

// ---------------------------------------------------------------------------
// SMS length / segments
// ---------------------------------------------------------------------------

/** Characters outside GSM-7 force UCS-2 encoding (70/67-char segments). */
const GSM7_CHARS = new Set(
  (
    '@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !"#\u00a4%&\'()*+,-./0123456789:;<=>?' +
    '\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0^{}\\[~]|\u20ac'
  ).split(''),
);

function isGsm7(body: string): boolean {
  for (const ch of body) if (!GSM7_CHARS.has(ch)) return false;
  return true;
}

export interface SmsSegmentInfo {
  chars: number;
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
}

/** Estimated billable SMS segments for a message body. */
export function smsSegmentInfo(body: string): SmsSegmentInfo {
  const chars = body.length;
  const gsm = isGsm7(body);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const segments = chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / multi);
  return { chars, segments, encoding: gsm ? 'GSM-7' : 'UCS-2' };
}

// ---------------------------------------------------------------------------
// Contact validation
// ---------------------------------------------------------------------------

/** Server-side email shape check — enough to keep garbage away from the provider. */
export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * A phone number we can normalize to E.164 for Jamaica (+1 876/658) or a stored
 * NANP/E.164 number. Mirrors toE164Jamaica's accepted shapes — anything else is
 * NOT silently "+1"-prefixed, it is rejected.
 */
export function isValidMobileNumber(raw: string): boolean {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return true;
  if (digits.length === 10) return true;
  if (digits.length === 7) return true; // local Jamaican number → +1876
  return false;
}
