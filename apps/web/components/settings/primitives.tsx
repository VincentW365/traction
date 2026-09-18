'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import type { CategoryIcon } from '../../lib/settings-catalogue';

/**
 * CR-2026-109 — the small pieces the administration console is built from.
 *
 * These exist so Settings and Resources & Bays look like the same product. They
 * lean on the shared classes in `globals.css` rather than carrying their own
 * styling vocabulary: a second design system for the admin area is how two
 * screens that should match quietly stop matching.
 */

// ---------------------------------------------------------------------------
// Icons — the same inline heroicon paths used throughout the app. Deliberately
// not a new icon package: one more dependency for eight glyphs is a bad trade.
// ---------------------------------------------------------------------------

const ICON_PATHS: Record<CategoryIcon, string> = {
  calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  gauge: 'M13 10V3L4 14h7v7l9-11h-7z',
  users: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  clipboard: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  list: 'M4 6h16M4 10h16M4 14h16M4 18h16',
  bell: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
  wrench: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  flask: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
};

export function Icon({ name, className = 'w-5 h-5' }: { name: CategoryIcon; className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={ICON_PATHS[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type StatusTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/**
 * A status chip. The WORD carries the meaning and the colour reinforces it —
 * never the other way round, so the screen still reads correctly in greyscale
 * or to someone who cannot separate the greens from the ambers.
 */
export function SettingStatus({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Landing-page cards
// ---------------------------------------------------------------------------

export function SettingsCategoryCard({
  href,
  icon,
  title,
  description,
  summary,
  status,
}: {
  href: string;
  icon: CategoryIcon;
  title: string;
  description: string;
  summary?: string;
  status?: { tone: StatusTone; label: string };
}) {
  return (
    <Link
      href={href}
      className="group surface p-5 flex flex-col gap-3 transition-all hover:border-slate-300 hover:shadow-md
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-lg bg-blue-50 p-2 text-blue-700 group-hover:bg-blue-100 transition-colors">
          <Icon name={icon} />
        </span>
        {status && <SettingStatus tone={status.tone}>{status.label}</SettingStatus>}
      </div>
      <div className="flex-1">
        <h3 className="text-base font-semibold text-slate-900 group-hover:text-blue-800 transition-colors">{title}</h3>
        <p className="text-sm text-slate-500 leading-relaxed mt-1">{description}</p>
      </div>
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-xs text-slate-400">{summary ?? ''}</span>
        <svg className="w-4 h-4 text-slate-300 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </Link>
  );
}

/** One figure in the status strip. Awareness, not another place to edit things. */
export function SettingsSummaryCard({
  label,
  value,
  tone = 'neutral',
  note,
}: {
  label: string;
  value: string;
  tone?: StatusTone;
  note?: string;
}) {
  const colour =
    tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900';
  return (
    <div className="px-4 py-3">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={`text-base font-semibold mt-0.5 ${colour}`}>{value}</dd>
      {note && <p className="text-xs text-slate-400 mt-0.5 leading-snug">{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections and rows
// ---------------------------------------------------------------------------

export function SettingsSection({
  title,
  help,
  action,
  children,
}: {
  title: string;
  help?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="surface overflow-hidden">
      <div className="surface-header flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {help && <p className="text-sm text-slate-500 mt-0.5 leading-relaxed max-w-2xl">{help}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="divide-y divide-slate-100">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  help,
  control,
  htmlFor,
  modified,
  inactiveNote,
  impact,
  technical,
  lastChanged,
}: {
  label: string;
  help: string;
  control: React.ReactNode;
  htmlFor?: string;
  modified?: boolean;
  /** Set when the setting governs nothing under the current mode. */
  inactiveNote?: string;
  /** Spelled-out consequence for a change that materially affects customers. */
  impact?: string;
  technical?: { key: string; value: string };
  lastChanged?: { by: string; at: string } | null;
}) {
  return (
    <div className={`setting-row ${inactiveNote ? 'bg-slate-50/50' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {/* A real <label> so clicking the text focuses the control and screen
              readers announce the pair. */}
          <label htmlFor={htmlFor} className="setting-label cursor-pointer">
            {label}
          </label>
          {modified && <SettingStatus tone="info">Modified</SettingStatus>}
          {inactiveNote && <SettingStatus tone="neutral">Not in use</SettingStatus>}
          {/* A quiet, permanent marker that this one matters. The consequence
              itself appears only once it is actually being changed — see below. */}
          {impact && !modified && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-700" title="Changing this has a significant operational effect">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
              </svg>
              Significant change
            </span>
          )}
        </div>
        <p className="setting-help">{help}</p>

        {inactiveNote && <p className="text-sm text-slate-500 mt-1.5 italic">{inactiveNote}</p>}

        {/*
          §9 — shown when the setting has actually been CHANGED, not permanently.
          Five standing amber panels on one page is wallpaper: the eye stops
          reading them, which is the opposite of what an impact warning is for.
          At the moment of the change it is unmissable.
        */}
        {impact && modified && (
          <p role="status" className="mt-2 flex gap-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
            <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
            </svg>
            <span>{impact}</span>
          </p>
        )}

        {(technical || lastChanged) && (
          <details className="mt-2 group">
            <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600 inline-flex items-center gap-1 list-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 rounded">
              <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Technical details
            </summary>
            <dl className="mt-1.5 pl-4 space-y-0.5 text-xs">
              {technical && (
                <>
                  <div className="flex gap-2">
                    <dt className="text-slate-400">Setting key</dt>
                    <dd className="font-mono text-slate-600">{technical.key}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-slate-400">Stored value</dt>
                    <dd className="font-mono text-slate-600 break-all">{technical.value}</dd>
                  </div>
                </>
              )}
              {lastChanged && (
                <div className="flex gap-2">
                  <dt className="text-slate-400">Last changed</dt>
                  <dd className="text-slate-600">
                    {lastChanged.by} · {lastChanged.at}
                  </dd>
                </div>
              )}
            </dl>
          </details>
        )}
      </div>
      <div className="setting-control">{control}</div>
    </div>
  );
}

/**
 * §14 — advanced options, collapsed. A manager should meet the settings they
 * make operational decisions about before the ones that exist for troubleshooting.
 */
export function AdvancedDisclosure({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className="border-t border-slate-100">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-5 py-3 flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/50"
      >
        <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        Advanced settings
        <span className="text-xs text-slate-400 font-normal">({count})</span>
      </button>
      {open && <div className="divide-y divide-slate-100 border-t border-slate-100">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Switch({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className={`switch ${checked ? 'switch-on' : 'switch-off'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
        {/* The checkbox is the control; the coloured track is decoration over
            it. Keyboard, form semantics and assistive tech all work for free. */}
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={label}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        />
        <span className={`switch-knob ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
      </span>
      <span className="text-sm font-medium text-slate-700">{checked ? 'On' : 'Off'}</span>
    </div>
  );
}

export function NumberWithUnit({
  id,
  value,
  unit,
  onChange,
  min,
  max,
  hint,
}: {
  id: string;
  value: number;
  unit?: string;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** The human translation — "2 hours" beside 120. */
  hint?: string | null;
}) {
  return (
    <div>
      <div className="input-with-unit">
        <input
          id={id}
          type="number"
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={max === 1 ? 0.1 : 1}
          onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

export function TimeControl({
  id,
  value,
  onChange,
  hint,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string | null;
}) {
  return (
    <div>
      <input id={id} type="time" value={value} onChange={(e) => onChange(e.target.value)} className="input-field" />
      {hint && <p className="text-xs text-slate-500 mt-1">Shown to customers as {hint}</p>}
    </div>
  );
}

export function SegmentedControl({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: Array<{ value: string; label: string; help?: string }>;
  onChange: (v: string) => void;
}) {
  const name = useId();
  const active = options.find((o) => o.value === value);
  return (
    <div>
      {/* A radio group, so arrow keys move between options and the current
          choice is announced — which a row of buttons would not do. */}
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <label
            key={o.value}
            className={`segmented-option ${o.value === value ? 'segmented-option-active' : ''}`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={o.value === value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
      {active?.help && <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{active.help}</p>}
    </div>
  );
}

export function ListControl({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      id={id}
      rows={Math.min(6, Math.max(2, value.length + 1))}
      value={value.join('\n')}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
      className="input-field font-mono text-xs"
    />
  );
}

/** A secondary action to a related tool. Quiet on purpose — §11. */
export function RelatedLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 rounded"
    >
      {children}
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  );
}
