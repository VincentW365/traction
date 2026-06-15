# CR-2026-036 — Reusable Data Export (CSV + PDF)

**Status:** IMPLEMENTED (autonomous run). **Type:** Web/UI feature — no API, schema, dependency, or auth change.
**Author:** Vincent Wilson · **Date:** 2026-06-15
**Approval gate:** Not a §9 trigger — no schema, no new third-party dependency, no auth/rule change. Client-only. Recorded for traceability.

## 1. Request
"When you download the data for viewing it can be CSV and PDF — properly formatted and outlined based off the file type chosen." Add a format-choosing export to the data-viewing screens; each format laid out appropriately for its type.

## 2. Decision
- **One shared exporter** drives both formats from a single `ExportDocument` model (title, filename, meta, and `sections[]` of heading/columns/rows) — so multi-table reports (service-mix) and simple lists export consistently.
- **CSV**: client-side `Blob` download — UTF-8 BOM (Excel-safe), RFC-4180 quoting, numbers unquoted (stay numeric), CRLF; preamble of title + meta then each section's header + rows.
- **PDF**: **dependency-free** — opens a branded, paginated print view (brand header, title, filters/meta, zebra tables, numeric columns right-aligned, footer) and triggers the browser print dialog → *Save as PDF*. Same pattern as the inspection print pages; **no new dependency** (respects §9). A one-click PDF library (jsPDF) was considered and declined to avoid the dependency.
- **Recommend, staff choose**: an `ExportMenu` dropdown (Download CSV / Download PDF) sits in each page's actions; the document is built lazily on click so it always reflects the current filters/page.

## 3. Files
- `apps/web/lib/export.ts` *(new)* — `ExportDocument`/`ExportSection` types, `buildCsv`/`downloadCsv`, `printPdf`.
- `apps/web/components/ui/export-menu.tsx` *(new)* — dropdown component.
- Reports: `reports/rework`, `reports/due-for-contact`, `reports/classification`, `reports/service-mix` (refactored 3 ad-hoc CSV buttons → ExportMenu + added an "Export all"), `reports/historical` (refactored inline CSV → shared util + PDF).
- Lists: `complaints`, `inspections`, `admin/audit-logs`, `customers`, `admin/assignments`.
- `docs/59_CR_2026_036_Data_Export.md` *(this file)*.

## 4. Scope / privacy
Exports reflect the **currently-loaded, filtered view** (e.g. the current customer-directory page; the active audit-log date range). Privacy preserved: the customer list shape carries **no phone** (CR-2026-021) and exports add a note to that effect; audit-log export includes the full entity id (the on-screen table truncates it). No customer-facing/token surfaces touched.

## 5. Risks
| Risk | Mitigation |
|---|---|
| Pop-up blocker stops the print window | `printPdf` detects a null window and alerts the user to allow pop-ups. |
| "PDF" misread as a server-rendered file | It's the browser's Save-as-PDF; documented; matches existing inspection print pattern. |
| Large lists exported partially | Exports the loaded page; meta states the count/range so the slice is explicit. |

## 6. Verification
Web `tsc --noEmit` green; web vitest 74/74 (route-smoke imports all 66 pages). `next lint` is now an interactive setup prompt (deprecated) and not runnable headless — typecheck is the gate. Manual: each page's Export → CSV downloads a formatted file; PDF opens the branded print view.
