'use client';

import { useMemo, useRef, useState } from 'react';

export interface SearchableOption {
  value: string;
  label: string;
  sublabel?: string;
}

/**
 * CR-2026-062 — lightweight, dependency-free searchable single-select (combobox).
 * A text input filters the option list; picking an option sets the value. Matches the
 * inline search pattern used elsewhere (CR-2026-052) but as a reusable control.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  emptyText = 'No matches',
  disabled = false,
  className = '',
}: {
  options: SearchableOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = options.find((o) => o.value === value) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      !q
        ? options
        : options.filter(
            (o) =>
              o.label.toLowerCase().includes(q) ||
              (o.sublabel ?? '').toLowerCase().includes(q),
          ),
    [options, q],
  );

  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        disabled={disabled}
        className="input-field text-xs"
        placeholder={placeholder}
        value={open ? query : selected?.label ?? ''}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">{emptyText}</div>
          ) : (
            filtered.map((o) => (
              <button
                key={o.value || '__auto__'}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o.value);
                  setOpen(false);
                  setQuery('');
                }}
                className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 ${
                  o.value === value ? 'bg-blue-50 font-medium' : ''
                }`}
              >
                {o.label}
                {o.sublabel ? <span className="text-slate-400"> · {o.sublabel}</span> : null}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
