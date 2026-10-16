/**
 * CR-2026-096 — safe placeholder rendering for customer notification templates.
 *
 * CR-2026-112 — email is the only channel this release sends on, so the SMS
 * segment/encoding maths and the mobile-number validator were removed with the
 * SMS provider. The placeholder set grew to cover the appointment and
 * customer-action emails, which are now template-driven rather than rendered in
 * application code.
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
  // CR-2026-112 — appointment emails (confirmation / changed / cancelled / reminder)
  'appointmentReference',
  'appointmentWhen',
  'appointmentServices',
  'appointmentDuration',
  'appointmentInstructions',
  'manageUrl',
  // CR-2026-112 — customer action required: what the customer must decide, and
  // by when. Both are written by the advisor; neither is ever auto-filled from
  // internal state (see docs/131 §6).
  'actionRequired',
  'actionNeededBy',
  // CR-2026-122 — the customer's own status link and when it stops working. Both
  // are filled from the visit, never typed; the send is refused when the visit
  // has no usable link, so a status-link email can never go out without one.
  'statusUrl',
  'statusLinkExpires',
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
 *
 * CR-2026-112 — a LABELLED line whose only value is missing is dropped whole.
 * The appointment emails are written as "Vehicle: {{vehicleDescription}}" and a
 * customer must never read a bare "Vehicle:" with nothing after it. A
 * placeholder inside a sentence still just disappears, exactly as before.
 */
export function renderTemplate(template: string, data: TemplateData): RenderResult {
  const unresolved: string[] = [];

  const lines = template.split('\n').map((line) => {
    let hadPlaceholder = false;
    let resolvedOne = false;
    const rendered = line.replace(PLACEHOLDER_RE, (_whole, key: string) => {
      hadPlaceholder = true;
      const value = (data as Record<string, unknown>)[key];
      if (value === null || value === undefined || String(value).trim() === '') {
        if (!unresolved.includes(key)) unresolved.push(key);
        return '';
      }
      resolvedOne = true;
      return String(value).trim();
    });
    return hadPlaceholder && !resolvedOne && isLabelOnly(rendered) ? null : rendered;
  });

  const text = tidyWhitespace(lines.filter((l): l is string => l !== null).join('\n'));
  return { text, unresolved };
}

/** What is left of a line once its only value vanished: nothing, or a bare label. */
function isLabelOnly(line: string): boolean {
  const rest = line.trim();
  return rest === '' || /^[^{}]{0,40}:$/.test(rest);
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
// Contact validation
// ---------------------------------------------------------------------------

/** Server-side email shape check — enough to keep garbage away from the provider. */
export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}
