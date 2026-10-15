'use client';

import { useSearchParams } from 'next/navigation';

/**
 * CR-2026-118 §4 — context-aware navigation for the job documents.
 *
 * A job sheet or inspection is opened FROM somewhere: a ticket on the queue, a
 * technician's own job, a visit record. Returning used to go to the general
 * Inspections list regardless, which threw the advisor out of the job they were
 * working and made them find it again. The origin now travels with the form as
 * `?from=<internal path>` and the back control returns there.
 *
 * Only an INTERNAL path is honoured. `from` is user-controllable (it is in the
 * URL), so anything that is not a plain root-relative path — a scheme, a
 * protocol-relative `//host`, a backslash trick — is dropped and the fallback is
 * used. The fallback is the document's own visit, never an unrelated page.
 */

export const RETURN_PARAM = 'from';

/** True only for a root-relative path that cannot leave this application. */
export function isInternalPath(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  if (!raw.startsWith('/')) return false;
  if (raw.startsWith('//')) return false; // protocol-relative → another host
  if (/[\\\u0000-\u001f]/.test(raw)) return false; // backslash / control chars
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(raw)) return false; // "/javascript:" style
  return true;
}

/** The validated return path, or the fallback when none was given or it is unsafe. */
export function safeReturnPath(raw: string | null | undefined, fallback: string): string {
  return isInternalPath(raw) ? raw : fallback;
}

/** Append the origin to a link into a document. */
export function withReturn(href: string, from: string | null | undefined): string {
  if (!isInternalPath(from)) return href;
  const sep = href.includes('?') ? '&' : '?';
  return `${href}${sep}${RETURN_PARAM}=${encodeURIComponent(from)}`;
}

/**
 * What the back control says, from where it goes. A label that names the
 * destination is the difference between "Back" (to what?) and knowing you will
 * land on the job you left.
 */
export function returnLabel(path: string): string {
  if (path.startsWith('/queue/')) return 'Back to Job';
  if (path.startsWith('/technician/jobs/')) return 'Back to My Job';
  if (path.startsWith('/technician')) return 'Back to My Jobs';
  if (path.startsWith('/visits/')) return 'Back to Visit Record';
  if (path.startsWith('/vehicles/')) return 'Back to Vehicle';
  if (path.startsWith('/customers/')) return 'Back to Customer';
  if (path.startsWith('/inspections')) return 'Back to Inspections';
  return 'Back';
}

/**
 * The origin for the current document, read from the URL, with the visit as the
 * fallback (§5.4F: a direct link with no context prefers the associated visit
 * over an unrelated general page).
 */
export function useReturnTo(fallback: string): { path: string; label: string; from: string | null } {
  const params = useSearchParams();
  const raw = params?.get(RETURN_PARAM) ?? null;
  const path = safeReturnPath(raw, fallback);
  return { path, label: returnLabel(path), from: isInternalPath(raw) ? raw : null };
}
