'use client';

import {
  ListControl,
  NumberWithUnit,
  SegmentedControl,
  Switch,
  TimeControl,
} from '../../../../../components/settings/primitives';
import type { SettingDef } from '../../../../../lib/settings-catalogue';

/**
 * CR-2026-109 §6 — the control that best communicates the rule.
 *
 * The old screen used one text box for everything and stored whatever JSON you
 * typed. That is maximally flexible and minimally useful: a manager could not
 * tell that `booking_same_day_allowed` wanted `true` rather than `"yes"`, and
 * nothing stopped them finding out the hard way.
 *
 * Each control here writes the shape the rule actually expects, so an invalid
 * value is not something a manager has to avoid by knowing the schema.
 */
export function Control({
  id,
  def,
  value,
  onChange,
  hint,
}: {
  id: string;
  def: SettingDef;
  value: unknown;
  onChange: (v: unknown) => void;
  hint?: string | null;
}) {
  switch (def.control) {
    case 'toggle':
      return <Switch id={id} checked={value === true} onChange={onChange} label={def.label} />;

    case 'number':
      return (
        <NumberWithUnit
          id={id}
          value={typeof value === 'number' ? value : NaN}
          unit={def.unit}
          min={def.min}
          max={def.max}
          hint={hint}
          onChange={(v) => onChange(Number.isFinite(v) ? v : null)}
        />
      );

    case 'time':
      return (
        <TimeControl
          id={id}
          // An empty string is how "no cutoff" is stored, and the time input
          // handles it natively — so clearing the field is a real answer rather
          // than an error to recover from.
          value={typeof value === 'string' ? value : ''}
          hint={hint}
          onChange={(v) => onChange(v === '' ? null : v)}
        />
      );

    case 'choice':
      return (
        <SegmentedControl
          id={id}
          value={String(value ?? '')}
          options={def.choices ?? []}
          onChange={onChange}
        />
      );

    case 'list':
      return (
        <ListControl
          id={id}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={onChange}
          placeholder="One per line"
        />
      );

    case 'textarea':
      return (
        <textarea
          id={id}
          rows={4}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className="input-field"
        />
      );

    case 'text':
      return (
        <input
          id={id}
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className="input-field"
        />
      );

    case 'json':
    default:
      // The escape hatch, for structured settings with no dedicated editor
      // (opening hours) and for anything the catalogue has not named yet. It is
      // the old behaviour, kept deliberately: an uneditable setting would be
      // worse than an ugly one.
      return <JsonControl id={id} value={value} onChange={onChange} />;
  }
}

function JsonControl({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let invalid = false;
  try {
    if (text.trim()) JSON.parse(text);
  } catch {
    invalid = true;
  }
  return (
    <div>
      <textarea
        id={id}
        rows={3}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          try {
            onChange(JSON.parse(raw));
          } catch {
            // Keep the keystrokes. Mid-edit JSON is invalid almost by
            // definition, and throwing the text away on every character would
            // make the field unusable.
            onChange(raw);
          }
        }}
        aria-invalid={invalid}
        className={`input-field font-mono text-xs ${invalid ? 'border-amber-400' : ''}`}
      />
      {invalid && <p className="text-xs text-amber-700 mt-1">Not valid JSON yet — it will be saved as plain text.</p>}
    </div>
  );
}
