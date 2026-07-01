# CR-2026-058 — Keep checked-in appointments visible on the schedule

**Status:** Implemented.
**Requested by:** Vincent Wilson — "When appointments are checked in they disappear off the schedule… it should stay there but greyed out / marked as checked in. The schedule should show exactly what is going on at all times."

## A. Objective
Stop checked-in appointments from vanishing from the Appointments calendar. Keep them on the
board with a clear checked-in / in-progress / completed visual state.

## B. Root cause
Purely frontend. The backend `/appointments` returns all statuses, but the schedule page
filtered the blocks to `['DRAFT','CONFIRMED','RESCHEDULED']`, so a `CHECKED_IN` appointment was
discarded before render. The calendar's `STATUS_STYLE` map also had no entry for the post-check-in
statuses.

## C. Change (frontend only)
- `schedule/page.tsx` — the appointment-block filter now **excludes only `CANCELLED` / `MISSED`**
  (truly off the board) instead of allow-listing three statuses. Everything else — including
  `CHECKED_IN`, `IN_PROGRESS`, `COMPLETED` — stays visible.
- `components/schedule/appointment-calendar.tsx` — added `STATUS_STYLE` entries:
  - `CHECKED_IN` → greyed body with a green accent border (reads as "in, checked in")
  - `IN_PROGRESS` → amber ("in service")
  - `COMPLETED` → faint slate ("done")
  and a small leading glyph (`✓` / `●`) via `STATUS_MARK` so the state reads without relying on
  color alone. The hover tooltip now shows a friendly status label.

## D. Impacted modules / data
- Web only: `apps/web/app/(dashboard)/schedule/page.tsx`, `apps/web/components/schedule/appointment-calendar.tsx`.
- No backend, DTO, schema, or endpoint change (the API already returned these appointments).

## E. Risks / tradeoffs
- `CANCELLED` / `MISSED` appointments remain hidden (they are not "happening"). If the shop later
  wants those shown greyed too, it's a one-line filter change plus a style entry.
- Checked-in appointments and walk-ins can both appear; walk-ins keep their solid emerald style,
  checked-in appointments are greyed with a ✓ — visually distinct.

## F. Tests / validation
- `pnpm --filter @bsop/web exec tsc --noEmit` — green.
- `pnpm --filter @bsop/web exec vitest run` — 74 passed.
- Manual: check in an appointment → it stays on the calendar, greyed with a ✓, instead of disappearing.

## G. Approval gate
Frontend rendering/visibility change over existing data. No schema/RBAC/scheduling-logic change →
**not a §9 trigger**. Recorded as a Change Request; reversible via git.
