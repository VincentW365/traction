'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../lib/api-client';
import { useSiteId } from '../../../../hooks/use-site';
import { PageHeader } from '../../../../components/ui/page-header';
import { LoadingState } from '../../../../components/ui/loading-state';
import {
  SettingsCategoryCard,
  SettingsSummaryCard,
  type StatusTone,
} from '../../../../components/settings/primitives';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_LAUNCHPADS,
  HIDDEN_RULE_KEYS,
  catalogued,
  choiceLabel,
  findSetting,
} from '../../../../lib/settings-catalogue';
import type { BusinessRule } from './shared';
import { PermissionDenied, ruleValue } from './shared';

/**
 * CR-2026-109 — the Service Centre Administration Console.
 *
 * What this replaced: one long table of `BusinessRuleConfig` rows, keyed by the
 * database column name, edited as raw JSON. It was honest about the storage and
 * useless about the job — a manager looking for "can customers still book
 * online?" had to know that the answer lives under `booking_enabled` and is
 * spelled `true`.
 *
 * The landing page now answers the six questions a manager actually opens
 * Settings with, then routes them to the right group. Individual values live one
 * level down, because a page that shows every setting at once is a page nobody
 * reads.
 */

interface ReadinessSummary {
  production: { ready: boolean };
  publicServices: Array<{ status: 'READY' | 'INCOMPLETE' }>;
  current: { capacityMode: string; durationSource: string; maxConcurrentAppointments: number | null };
}

export default function SettingsPage() {
  const siteId = useSiteId();

  const rulesQuery = useQuery({
    queryKey: ['business-rules', siteId],
    queryFn: () => api.get<BusinessRule[]>(`/config/business-rules?siteId=${siteId}`),
    enabled: !!siteId,
  });

  // Readiness enriches the strip but must never be able to break Settings:
  // it needs a different permission, and a manager without it should still be
  // able to change the opening hours.
  const readinessQuery = useQuery<ReadinessSummary>({
    queryKey: ['resource-readiness-summary', siteId],
    queryFn: () => api.get(`/resources/readiness?siteId=${siteId}`),
    enabled: !!siteId,
    retry: false,
  });

  // The endpoint already returns only ACTIVE services and omits the flag, so
  // filtering on `isActive` here silently counted zero.
  const services = useQuery<Array<{ bookableOnline: boolean }>>({
    queryKey: ['settings-services'],
    queryFn: () => api.get('/service-types'),
    retry: false,
  });

  const is403 =
    rulesQuery.isError && rulesQuery.error instanceof Error && rulesQuery.error.message.includes('403');

  if (rulesQuery.isLoading) {
    return (
      <div className="page-container">
        <PageHeader title="Settings" subtitle="Loading configuration…" />
        <LoadingState message="Loading settings…" />
      </div>
    );
  }

  if (rulesQuery.isError) {
    return (
      <div className="page-container">
        <PageHeader title="Settings" />
        {is403 ? (
          <PermissionDenied />
        ) : (
          <div className="surface p-6 border-red-200 bg-red-50">
            <p className="text-sm text-red-800">Settings could not be loaded. Refresh to try again.</p>
          </div>
        )}
      </div>
    );
  }

  const rules = rulesQuery.data ?? [];
  const value = (key: string) => ruleValue(rules, key);

  const bookingOn = value('booking_enabled') === true;
  const capacityMode = String(value('booking_capacity_mode') ?? 'FIXED');
  const durationSource = String(value('appointment_duration_source') ?? 'DEFAULT');
  const concurrency = value('booking_max_concurrent_appointments');
  const publicServiceCount = (services.data ?? []).filter((s) => s.bookableOnline).length;
  const readiness = readinessQuery.data;
  const servicesReady = readiness?.publicServices.filter((s) => s.status === 'READY').length ?? 0;
  const servicesTotal = readiness?.publicServices.length ?? 0;

  // Anything live that the catalogue does not name. Shown rather than dropped —
  // presentation work must not make a business rule unreachable.
  const known = new Set(catalogued());
  const uncatalogued = rules.filter((r) => !known.has(r.ruleKey) && !HIDDEN_RULE_KEYS.has(r.ruleKey));

  return (
    <div className="page-container space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Configure how the Service Centre handles bookings, customers, resources, notifications and workshop operations."
        breadcrumbs={[{ label: 'Dashboard', href: '/' }, { label: 'Setup' }, { label: 'Settings' }]}
      />

      {/* ---- status strip: awareness, not another place to edit ---------- */}
      <div className="surface overflow-hidden">
        <dl className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 divide-x divide-y md:divide-y-0 divide-slate-100">
          <SettingsSummaryCard
            label="Online Booking"
            value={bookingOn ? 'Active' : 'Inactive'}
            tone={bookingOn ? 'good' : 'bad'}
          />
          <SettingsSummaryCard
            label="Public Services"
            value={services.isError ? '—' : `${publicServiceCount} offered`}
            note={services.isError ? undefined : 'Bookable by customers'}
          />
          <SettingsSummaryCard
            label="Scheduling"
            value={choiceLabel(findSetting('booking_capacity_mode'), capacityMode)}
            note={capacityMode === 'FIXED' && typeof concurrency === 'number' ? `${concurrency} at a time` : undefined}
          />
          <SettingsSummaryCard
            label="Appointment Length"
            value={choiceLabel(findSetting('appointment_duration_source'), durationSource)}
          />
          <SettingsSummaryCard
            label="Resource-Aware"
            value={capacityMode === 'FIXED' ? 'Shadow mode' : 'Live'}
            tone={capacityMode === 'FIXED' ? 'info' : 'good'}
            note={capacityMode === 'FIXED' ? 'Running alongside, decides nothing' : undefined}
          />
          {/* CR-2026-121 — while the fixed limit is in use, resource readiness is
              a fact about a mode nobody has chosen, so it is reported, not
              shouted. "Needs setup" is reserved for the case where resource-aware
              scheduling is live and its checks no longer pass. */}
          <SettingsSummaryCard
            label="Resource Readiness"
            value={
              readinessQuery.isError
                ? '—'
                : readiness
                  ? readiness.production.ready
                    ? 'Ready'
                    : capacityMode === 'FIXED'
                      ? 'Shadow only'
                      : 'Needs setup'
                  : 'Checking…'
            }
            tone={readiness ? (readiness.production.ready ? 'good' : capacityMode === 'FIXED' ? 'info' : 'warn') : 'neutral'}
            note={readiness && servicesTotal > 0 ? `${servicesReady} of ${servicesTotal} services covered` : undefined}
          />
        </dl>
      </div>

      {/* ---- categories --------------------------------------------------- */}
      <div>
        <h2 className="text-sm font-semibold text-slate-900 mb-3">Configuration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {SETTINGS_CATEGORIES.map((c) => (
            <SettingsCategoryCard
              key={c.slug}
              href={`/admin/settings/${c.slug}`}
              icon={c.icon}
              title={c.title}
              description={c.description}
              summary={categorySummary(c.slug, rules)}
              status={categoryStatus(c.slug, { bookingOn, readiness, capacityMode })}
            />
          ))}
          {SETTINGS_LAUNCHPADS.map((l) => (
            <SettingsCategoryCard
              key={l.slug}
              href={`/admin/settings/${l.slug}`}
              icon={l.icon}
              title={l.title}
              description={l.description}
              summary={l.slug === 'services' && !services.isError ? `${publicServiceCount} offered online` : undefined}
            />
          ))}
        </div>
      </div>

      {/* ---- anything the catalogue does not name ------------------------ */}
      {uncatalogued.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-900 mb-1">Other settings</h2>
          <p className="text-sm text-slate-500 mb-3 max-w-2xl leading-relaxed">
            Live settings that have not been given a plain-language name yet. They are shown here so nothing becomes
            unreachable — the value is the one the system is actually using.
          </p>
          {/* Constrained to one column of the same grid: a single card stretched
              across the full width reads as a banner, not as one more category. */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <SettingsCategoryCard
              href="/admin/settings/other"
              icon="list"
              title="Uncategorised"
              description="Settings without a plain-language name, shown with their stored values."
              summary={`${uncatalogued.length} setting${uncatalogued.length === 1 ? '' : 's'}`}
              status={{ tone: 'neutral', label: 'Technical' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** A short, honest summary line. Never every value — that is what the page is for. */
function categorySummary(slug: string, rules: BusinessRule[]): string | undefined {
  const v = (k: string) => ruleValue(rules, k);
  switch (slug) {
    case 'booking': {
      const notice = v('booking_min_notice_minutes');
      const ahead = v('booking_advance_window_days');
      return typeof notice === 'number' && typeof ahead === 'number'
        ? `${notice} min notice · up to ${ahead} days ahead`
        : undefined;
    }
    case 'queue': {
      const early = v('protected_window_early_min');
      const late = v('protected_window_late_min');
      return typeof early === 'number' && typeof late === 'number'
        ? `Protected ${early} min early, ${late} min late`
        : undefined;
    }
    case 'notifications':
      return v('appointment_reminder_enabled') === true ? 'Appointment reminders on' : 'Appointment reminders off';
    case 'workshop':
      return v('display_board_enabled') === true ? 'Waiting area display on' : undefined;
    default:
      return undefined;
  }
}

function categoryStatus(
  slug: string,
  ctx: { bookingOn: boolean; readiness?: ReadinessSummary; capacityMode: string },
): { tone: StatusTone; label: string } | undefined {
  if (slug === 'booking') {
    return ctx.bookingOn ? { tone: 'good', label: 'Active' } : { tone: 'bad', label: 'Inactive' };
  }
  if (slug === 'capacity' && ctx.readiness) {
    if (ctx.readiness.production.ready) return { tone: 'good', label: 'Ready' };
    // CR-2026-121 — on the fixed limit this is information, not a to-do.
    return ctx.capacityMode === 'FIXED'
      ? { tone: 'info', label: 'Fixed limit' }
      : { tone: 'warn', label: 'Needs setup' };
  }
  return undefined;
}
