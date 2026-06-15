// Shared client-side data export: CSV and print-to-PDF, formatted per file type.
// One ExportDocument model drives both, so every report/list exports consistently.
// No third-party dependencies — PDF uses a branded print view (Save as PDF).

export type ExportCell = string | number | null | undefined;
export type ExportAlign = 'left' | 'right' | 'center';

export interface ExportSection {
  /** Optional section heading (PDF: bold sub-heading; CSV: a labelled row). */
  heading?: string;
  /** Column header row. */
  columns?: string[];
  /** Data rows. */
  rows?: ExportCell[][];
  /** Optional per-column alignment for PDF; defaults to right for numeric cells. */
  align?: ExportAlign[];
  /** Optional note rendered under the section (PDF small print; CSV a trailing row). */
  note?: string;
}

export interface ExportDocument {
  /** Document title (e.g. "Rework / First-Time-Fix Report"). */
  title: string;
  /** Base file name, no extension (e.g. "rework-report"). */
  filename: string;
  subtitle?: string;
  /** Key/value context shown in the header (e.g. [["Range", "Jan–Jun"]]). */
  meta?: Array<[string, string]>;
  sections: ExportSection[];
}

const BRAND = "Bert's Auto Parts Service Centre";

function nowStamp(): string {
  return new Date().toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Meta with an auto-appended "Generated" timestamp (unless the caller already set one). */
function metaWithStamp(meta?: Array<[string, string]>): Array<[string, string]> {
  const m = [...(meta ?? [])];
  if (!m.some(([k]) => k.toLowerCase() === 'generated')) m.push(['Generated', nowStamp()]);
  return m;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(v: ExportCell): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  // Quote strings; double embedded quotes (RFC 4180).
  return `"${String(v).replace(/"/g, '""')}"`;
}

function csvRow(cells: ExportCell[]): string {
  return cells.map(csvCell).join(',');
}

export function buildCsv(doc: ExportDocument): string {
  const lines: string[] = [];
  lines.push(csvRow([doc.title]));
  if (doc.subtitle) lines.push(csvRow([doc.subtitle]));
  for (const [k, v] of metaWithStamp(doc.meta)) lines.push(csvRow([`${k}:`, v]));
  lines.push('');

  doc.sections.forEach((s, i) => {
    if (i > 0) lines.push('');
    if (s.heading) lines.push(csvRow([s.heading]));
    if (s.columns) lines.push(csvRow(s.columns));
    for (const row of s.rows ?? []) lines.push(csvRow(row));
    if (s.note) lines.push(csvRow([s.note]));
  });

  // UTF-8 BOM so Excel renders accents; CRLF line endings.
  return '﻿' + lines.join('\r\n');
}

export function downloadCsv(doc: ExportDocument): void {
  const blob = new Blob([buildCsv(doc)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${doc.filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// PDF (branded print view -> Save as PDF)
// ---------------------------------------------------------------------------

function esc(v: ExportCell): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sectionHtml(s: ExportSection): string {
  const heading = s.heading ? `<h2>${esc(s.heading)}</h2>` : '';
  const alignFor = (cell: ExportCell, col: number): ExportAlign =>
    s.align?.[col] ?? (typeof cell === 'number' ? 'right' : 'left');

  const thead = s.columns
    ? `<thead><tr>${s.columns
        .map((c, i) => `<th style="text-align:${s.align?.[i] ?? 'left'}">${esc(c)}</th>`)
        .join('')}</tr></thead>`
    : '';

  const tbody = (s.rows ?? [])
    .map(
      (row) =>
        `<tr>${row
          .map((cell, i) => `<td style="text-align:${alignFor(cell, i)}">${esc(cell)}</td>`)
          .join('')}</tr>`,
    )
    .join('');

  const table = s.columns || (s.rows && s.rows.length)
    ? `<table>${thead}<tbody>${tbody}</tbody></table>`
    : '';
  const note = s.note ? `<p class="note">${esc(s.note)}</p>` : '';
  const empty = !tbody && s.rows ? `<p class="note">No rows.</p>` : '';
  return `${heading}${table}${empty}${note}`;
}

export function printPdf(doc: ExportDocument): void {
  const w = window.open('', '_blank', 'noopener,noreferrer,width=1000,height=800');
  if (!w) {
    // Popup blocked — surface clearly rather than failing silently.
    alert('Please allow pop-ups for this site to download/print the PDF.');
    return;
  }

  const meta = metaWithStamp(doc.meta);
  const metaHtml = meta.length
    ? `<div class="meta">${meta.map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>`
    : '';
  const body = doc.sections.map(sectionHtml).join('');

  w.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(doc.filename)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; font-size: 11px; margin: 0; }
  .brand { color: #16a34a; font-weight: 700; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
  h1 { font-size: 18px; margin: 2px 0 2px; color: #0f172a; }
  .subtitle { color: #475569; font-size: 12px; margin: 0 0 8px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 18px; color: #475569; font-size: 10.5px;
          border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; padding: 6px 0; margin-bottom: 12px; }
  h2 { font-size: 12.5px; margin: 16px 0 6px; color: #0f172a; border-left: 3px solid #16a34a; padding-left: 7px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  th { background: #0f172a; color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: .03em;
       padding: 5px 7px; border: 1px solid #0f172a; }
  td { padding: 4px 7px; border: 1px solid #e2e8f0; font-size: 10.5px; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f8fafc; }
  .note { color: #64748b; font-size: 10px; margin: 2px 0 10px; font-style: italic; }
  .foot { position: fixed; bottom: 6mm; left: 0; right: 0; display: flex; justify-content: space-between;
          color: #94a3b8; font-size: 9px; border-top: 1px solid #e2e8f0; padding-top: 4px; }
  @media print { .foot { position: fixed; } }
</style>
</head>
<body>
  <div class="brand">${esc(BRAND)}</div>
  <h1>${esc(doc.title)}</h1>
  ${doc.subtitle ? `<p class="subtitle">${esc(doc.subtitle)}</p>` : ''}
  ${metaHtml}
  ${body}
  <div class="foot"><span>${esc(BRAND)}</span><span>${esc(doc.title)}</span></div>
  <script>
    window.focus();
    window.onload = function () { setTimeout(function () { window.print(); }, 120); };
    window.onafterprint = function () { window.close(); };
  </script>
</body>
</html>`);
  w.document.close();
}
