'use client';

import { useAuth } from './use-auth';

/**
 * Returns the current user's siteId from the authenticated session.
 *
 * CR-2026-098b — the old fallback was a HARD-CODED UUID from a long-gone dev
 * seed: on any freshly-seeded database it pointed at a site that does not
 * exist, silently scoping every query to nothing. Every seeded and
 * staff-created account carries a real siteId; if one ever doesn't, an empty
 * string makes the site-guarded queries (`enabled: !!siteId`) show no data
 * instead of the wrong site's data.
 */
export function useSiteId(): string {
  const { user } = useAuth();
  return user?.siteId ?? '';
}
