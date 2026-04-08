'use client';

import { useAuth } from './use-auth';

/**
 * Returns the current user's siteId from the authenticated session.
 * Falls back to seed site ID if user has no site assigned (e.g., admin).
 */
const FALLBACK_SITE_ID = 'c5e6adc6-f46e-4955-8952-763ccc002d80';

export function useSiteId(): string {
  const { user } = useAuth();
  return user?.siteId ?? FALLBACK_SITE_ID;
}
