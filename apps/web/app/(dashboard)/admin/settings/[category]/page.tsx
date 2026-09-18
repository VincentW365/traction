'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../../lib/api-client';
import { useSiteId } from '../../../../../hooks/use-site';
import { PageHeader } from '../../../../../components/ui/page-header';
import { LoadingState } from '../../../../../components/ui/loading-state';
import {
  AdvancedDisclosure,
  Icon,
  RelatedLink,
  SettingRow,
  SettingStatus,
  SettingsSection,
} from '../../../../../components/settings/primitives';
import {
  HIDDEN_RULE_KEYS,
  SETTINGS_CATEGORIES,
  SETTINGS_LAUNCHPADS,
  catalogued,
  findCategory,
  humaniseDays,
  humaniseMinutes,
  to12Hour,
  type SettingDef,
  type SettingsSectionDef,
} from '../../../../../lib/settings-catalogue';
import { Control } from './control';
import { ResourceReadinessPanel } from './readiness-panel';
import type { BusinessRule } from '../shared';
import { PermissionDenied, lastChangedOf, ruleRow, ruleValue } from '../shared';

/**
 * CR-2026-109 — one group of settings.
 *
 * Saving is per SECTION rather than per page or per field. Per page means a
 * manager changing the opening hours also re-saves nine unrelated rules; per
 * field means a save button beside every input, which is what made the old
 * screen feel like a database form. A section is the unit somebody actually
 * thinks in: "I have finished with online booking".
 */

type Draft = Record<string, unknown>;

export default function SettingsCategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const { category: slug } = use(params);
  const siteId = useSiteId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: ['business-rules', siteId],
    queryFn: () => api.get<BusinessRule[]>(`/config/business-rules?siteId=${siteId}`),
    enabled: !!siteId,
  });

  const launchpad = SETTINGS_LAUNCHPADS.find((l) => l.slug === slug);
  const category = findCategory(slug);
  const isOther = slug === 'other';
  if (!category && !launchpad && !isOther) notFound();

  const rules = useMemo(() => rulesQuery.data ?? [], [rulesQuery.data]);

  /** Sections for this page, including the synthetic "other" catch-all. */
  const sections: SettingsSectionDef[] = useMemo(() => {
    if (category) return category.sections;
    if (!isOther) return [];
    const known = new Set(catalogued());
    const orphans = rules.filter((r) => !known.has(r.ruleKey) && !HIDDEN_RULE_KEYS.has(r.ruleKey));
    return [
      {
        title: 'Uncategorised settings',
        help: 'These control real behaviour but have not been given a plain-language name yet. Values are shown exactly as stored.',
        settings: orphans.map<SettingDef>((r) => ({
          key: r.ruleKey,
          label: r.ruleKey,
          help: 'No description has been written for this setting yet.',
          control: 'json',
        })),
      },
    ];
  }, [category, isOther, rules]);

  const is403 = rulesQuery.isError && rulesQuery.error instanceof Error && rulesQuery.error.message.includes('403');
  const title = category?.title ?? launchpad?.title ?? 'Other settings';
  const description = category?.description ?? launchpad?.description ?? '';

  // --- the live value of a key, preferring an unsaved edit -------------------
  const current = (key: string) => (key in draft ? draft[key] : ruleValue(rules, key));
  const isModified = (key: string) =>
    key in draft && JSON.stringify(draft[key]) !== JSON.stringify(ruleValue(rules, key));

  function setValue(key: string, v: unknown) {
    setSaved(null);
    setError(null);
    setDraft((d) => ({ ...d, [key]: v }));
  }

  async function saveSection(section: SettingsSectionDef) {
    const changed = section.settings.filter((s) => isModified(s.key));
    if (changed.length === 0 || saving) return;
    setSaving(section.title);
    setError(null);
    try {
      // Sequential on purpose: each rule is its own versioned row with its own
      // audit entry, and a half-applied parallel batch would be harder to read
      // back than a half-applied sequential one.
      for (const s of changed) {
        await api.patch(`/config/business-rules/${s.key}?siteId=${siteId}`, {
          value: draft[s.key],
          notes: 'Changed from Settings',
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['business-rules'] });
      await queryClient.invalidateQueries({ queryKey: ['resource-readiness-summary'] });
      setDraft((d) => {
        const next = { ...d };
        for (const s of changed) delete next[s.key];
        return next;
      });
      setSaved(section.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change could not be saved.');
    } finally {
      setSaving(null);
    }
  }

  if (rulesQuery.isLoading) {
    return (
      <div className="page-container">
        <PageHeader title={title} breadcrumbs={crumbs(title)} />
        <LoadingState message="Loading settings…" />
      </div>
    );
  }
  if (rulesQuery.isError) {
    return (
      <div className="page-container">
        <PageHeader title={title} breadcrumbs={crumbs(title)} />
        {is403 ? <PermissionDenied /> : <div className="surface p-6 border-red-200 bg-red-50"><p className="text-sm text-red-800">Settings could not be loaded.</p></div>}
      </div>
    );
  }

  return (
    <div className="page-container space-y-6">
      <PageHeader title={title} subtitle={description} breadcrumbs={crumbs(title)} />

      {error && (
        <div role="alert" className="surface border-red-200 bg-red-50 px-5 py-3">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* ---- a launchpad sends you to the tool, it does not fake a form --- */}
      {launchpad && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {launchpad.links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="surface p-5 flex items-start gap-4 transition-all hover:border-slate-300 hover:shadow-md
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
            >
              <span className="rounded-lg bg-blue-50 p-2 text-blue-700 shrink-0">
                <Icon name={launchpad.icon} />
              </span>
              <span className="min-w-0">
                <span className="block text-base font-semibold text-slate-900">{l.label}</span>
                <span className="block text-sm text-slate-500 mt-0.5 leading-relaxed">{l.help}</span>
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* ---- readiness, beside the control it explains (§10) -------------- */}
      {slug === 'capacity' && <ResourceReadinessPanel siteId={siteId} />}

      {/* ---- the sections ------------------------------------------------- */}
      {sections.map((section) => {
        const visible = section.settings.filter((s) => !s.advanced && ruleRow(rules, s.key));
        const advanced = section.settings.filter((s) => s.advanced && ruleRow(rules, s.key));
        if (visible.length === 0 && advanced.length === 0) return null;
        const changedCount = section.settings.filter((s) => isModified(s.key)).length;

        return (
          <SettingsSection
            key={section.title}
            title={section.title}
            help={section.help}
            action={
              <SectionSave
                changedCount={changedCount}
                saving={saving === section.title}
                saved={saved === section.title}
                onSave={() => saveSection(section)}
              />
            }
          >
            {visible.map((s) => (
              <Row key={s.key} def={s} rules={rules} current={current} modified={isModified(s.key)} onChange={setValue} />
            ))}
            <AdvancedDisclosure count={advanced.length}>
              {advanced.map((s) => (
                <Row key={s.key} def={s} rules={rules} current={current} modified={isModified(s.key)} onChange={setValue} />
              ))}
            </AdvancedDisclosure>
          </SettingsSection>
        );
      })}

      {/* ---- related tools, as secondary actions (§11) ---------------------
           Suppressed on Capacity & Resources: the readiness panel above already
           carries both links, and repeating them under a "Related" heading
           three inches lower is clutter, not navigation. */}
      {category?.links && category.links.length > 0 && slug !== 'capacity' && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1">
          <span className="text-sm text-slate-500">Related:</span>
          {category.links.map((l) => (
            <RelatedLink key={l.href} href={l.href}>
              {l.label}
            </RelatedLink>
          ))}
        </div>
      )}
    </div>
  );
}

function crumbs(title: string) {
  return [{ label: 'Setup' }, { label: 'Settings', href: '/admin/settings' }, { label: title }];
}

function Row({
  def,
  rules,
  current,
  modified,
  onChange,
}: {
  def: SettingDef;
  rules: BusinessRule[];
  current: (key: string) => unknown;
  modified: boolean;
  onChange: (key: string, v: unknown) => void;
}) {
  const id = `setting-${def.key}`;
  const value = current(def.key);
  const row = ruleRow(rules, def.key);

  // §8 — a setting that governs nothing under the current mode is shown greyed
  // with the reason. Inactive configuration must not look active.
  const gate = def.activeWhen;
  const inactive = gate && String(current(gate.key) ?? '') !== gate.equals ? gate.inactiveNote : undefined;

  return (
    <SettingRow
      label={def.label}
      help={def.help}
      htmlFor={id}
      modified={modified}
      inactiveNote={inactive}
      impact={def.impact}
      technical={{ key: def.key, value: JSON.stringify(value) }}
      lastChanged={lastChangedOf(row)}
      control={<Control id={id} def={def} value={value} onChange={(v) => onChange(def.key, v)} hint={hintFor(def, value)} />}
    />
  );
}

/** The human translation beside a raw number — "2 hours" next to 120. */
function hintFor(def: SettingDef, value: unknown): string | null {
  if (def.control === 'time') return to12Hour(value);
  if (def.control !== 'number') return null;
  if (def.unit === 'minutes') return humaniseMinutes(value);
  if (def.unit === 'days') return humaniseDays(value);
  if (def.unit === 'hours' && typeof value === 'number' && value >= 24) {
    const d = value / 24;
    return Number.isInteger(d) ? `${d} day${d === 1 ? '' : 's'}` : null;
  }
  return null;
}

/**
 * §12 — save per section, disabled when nothing changed, with quiet inline
 * confirmation. No browser alert, no full-page reload, no scroll jump.
 */
function SectionSave({
  changedCount,
  saving,
  saved,
  onSave,
}: {
  changedCount: number;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}) {
  if (changedCount === 0) {
    return saved ? (
      <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700" role="status">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Saved
      </span>
    ) : null;
  }
  return (
    <div className="flex items-center gap-3">
      <SettingStatus tone="info">
        {changedCount} unsaved change{changedCount === 1 ? '' : 's'}
      </SettingStatus>
      <button onClick={onSave} disabled={saving} className="btn-primary py-1.5 px-3 text-sm">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
