'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api-client';
import { useAuth } from './use-auth';
import { useSiteId } from './use-site';

/**
 * CR-2026-116 — is a feature switched on for this site?
 *
 * The value is a `BusinessRuleConfig` row like every other setting, read through
 * the same query key the Settings screens use, so switching one off updates the
 * navigation on the next cache invalidation instead of needing a reload.
 *
 * Two deliberate choices:
 *
 * 1. The default while loading, or when the query is not run, is ON. Nav that
 *    flickers a tool away and back on every page load is worse than nav that is
 *    briefly honest about the last known state — and a manager who cannot read
 *    the rules is not someone we should be hiding tools from on that basis.
 * 2. It only asks when the signed-in user could actually read the rules
 *    (CONFIG_VIEW is a Manager permission). A technician's sidebar firing a
 *    request that always 403s would be noise, and every feature-gated item is
 *    Manager-only anyway.
 */
export const FEATURES = {
  BOOKING_SIMULATOR: 'booking_simulator_enabled',
} as const;

interface RuleRow {
  ruleKey: string;
  valueJson: unknown;
}

export function useFeatureEnabled(ruleKey: string): boolean {
  const siteId = useSiteId();
  const { user, sandboxRunId } = useAuth();
  const mayReadRules = sandboxRunId != null || user?.roleCode === 'ADMIN';

  const { data } = useQuery<RuleRow[]>({
    queryKey: ['business-rules', siteId],
    queryFn: () => api.get<RuleRow[]>(`/config/business-rules?siteId=${siteId}`),
    enabled: !!siteId && mayReadRules,
    retry: false,
    staleTime: 60_000,
  });

  if (!data) return true;
  const row = data.find((r) => r.ruleKey === ruleKey);
  // No row at all means this deployment predates the switch — and a feature
  // that existed yesterday must not vanish because a migration has not run.
  return row ? row.valueJson === true : true;
}
