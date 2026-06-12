/**
 * CR-2026-027 — separator-insensitive normalization for code/plate lookups.
 *
 * Vehicle codes are stored as `SC{plate}` (no separators, uppercase). Staff may
 * type the SharePoint form `SC1211KC`, our old hyphenated `SC-1211KC`, or just
 * the bare plate `1211 KC`. Normalizing the query (strip non-alphanumerics +
 * uppercase) lets all of those match the stored code via a `contains` filter.
 */
export function normalizeCodeQuery(q: string): string {
  return (q || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
