'use client';

import { useState } from 'react';
import { downloadCsv, printPdf, type ExportDocument } from '../../lib/export';

interface ExportMenuProps {
  /**
   * Built lazily when a format is chosen, so the export always reflects current
   * data/filters. Return null to make the menu a no-op (e.g. data not loaded yet).
   */
  build: () => ExportDocument | null;
  disabled?: boolean;
  label?: string;
}

export function ExportMenu({ build, disabled, label = 'Export' }: ExportMenuProps) {
  const [open, setOpen] = useState(false);

  const run = (fn: (doc: ExportDocument) => void) => {
    setOpen(false);
    const doc = build();
    if (doc) fn(doc);
  };

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-secondary"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
        </svg>
        {label}
        <svg className="w-3 h-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-1 w-44 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => run(downloadCsv)}
            >
              <span className="badge bg-emerald-50 text-emerald-700 font-semibold">CSV</span>
              Download CSV
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => run(printPdf)}
            >
              <span className="badge bg-red-50 text-red-700 font-semibold">PDF</span>
              Download PDF
            </button>
          </div>
        </>
      )}
    </div>
  );
}
