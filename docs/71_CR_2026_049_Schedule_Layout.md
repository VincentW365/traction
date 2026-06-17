# CR-2026-049 — Schedule calendar: fix walk-in clipping + multi-appointment layout

**Status:** IMPLEMENTED. **Type:** Schedule UI fix (CR-2026-045 follow-up) — owner-reported. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
"Fix the schedule — part of the walk-in is not showing. Ensure the best layout to accommodate multiple appointments in a time slot."

## 2. Causes
On the Appointments calendar (`components/schedule/appointment-calendar.tsx`):
1. **Walk-in clipping** — a walk-in's nominal block was ~20–24px tall but always rendered **two lines** (time + customer name). With `overflow-hidden`, the second line (the customer name) was cut off — "part of the walk-in not showing."
2. **Crowded slots** — concurrent items were packed into columns that split **100% of the lane width**, so several items in the same slot each became an unreadable sliver. There was no minimum column width and no horizontal scroll.

## 3. Change
- **Minimum column width + horizontal scroll.** The lane's `minWidth` is now `gutter + maxConcurrentColumns × 120px`. When a slot has more overlapping items than fit, the lane grows and scrolls horizontally so **every block stays ≥ ~116px wide and readable**, instead of being squeezed. When slots are sparse the lane still fills 100% width (unchanged look).
- **Responsive one/two-line blocks.** Each block shows two lines (time, then name) only when it's tall enough (`height ≥ 30px`); shorter blocks show a single combined line (`time · name`). Nothing is ever clipped, at any zoom, for appointments, holds, or walk-ins.
- **Walk-in nominal block 20 → 30 min** so walk-ins read as a proper two-line block at standard/detailed zoom (and a clean single line at compact). Full detail remains in the hover tooltip.

Column packing still guarantees overlapping items never visually collide (each gets its own column); this CR only sets a floor on column width and makes block content fit the available height.

## 4. Files
- `apps/web/components/schedule/appointment-calendar.tsx`
- `docs/71_CR_2026_049_Schedule_Layout.md` (this file)

## 5. Verification
- Web typecheck green; route-smoke green (66/66).
- Logic check: at standard zoom a walk-in = 36px → two lines fit; at compact = ~22px → single line, no clip. Densest cluster → each column ≥ 116px with horizontal scroll; sparse → full-width blocks as before.

## 6. Governance
Presentational change only — no schema, API, rule, or auth change. Not a §9 trigger.
