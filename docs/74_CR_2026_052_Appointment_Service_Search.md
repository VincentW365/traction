# CR-2026-052 — Searchable services list in the new-appointment wizard

**Status:** IMPLEMENTED. **Type:** UI tweak — owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-19

## 1. Request
"In the Choose Services section when creating appointments, make the list searchable."

## 2. Change
- `apps/web/app/(dashboard)/appointments/new/page.tsx` — Step 3 (Choose Services) now has a search box above the checkbox list. It filters the services by **name, family, or code** (case-insensitive) as you type. Selections persist even when a chosen service is filtered out of view, and a "No services match …" message shows when nothing matches. The duration/summary and Next button are unchanged.
- `apps/web/app/(dashboard)/check-in/page.tsx` — the **Walk-In Service Selection** list gets the same search box, filter behaviour, and "no matches" message (search resets on Cancel / form reset).

## 3. Verification
- Web typecheck green; route-smoke 66/66.

## 4. Governance
Presentational only — no schema/API/rule/auth change. Not a §9 trigger.
