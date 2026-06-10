# Change Request — Classification Productivity Tools

**CR ID:** CR-2026-012
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-008/009/010 (classification backend, queue UI, progress report).

---

## A. Objective
Give managers throughput visibility while staff clear the classification backlog: a **daily target**, **confirmation velocity** over a window, and a **per-reviewer** breakdown. Read-only over existing audit data (`reviewedByUserId`, `reviewedAt`, `status=CONFIRMED` on `VehicleClassification`). No schema change, no writes.

## B. Approach (approved)
- Read-only `getProductivity({ days })` on `ClassificationService` + `GET /vehicles/classification/productivity` (`REPORT_VIEW`, ADMIN/MANAGER).
- **Daily target** from **`BusinessRuleConfig`** (ruleKey `classification_daily_target`, `valueJson` e.g. `{ "target": 50 }`), read via the existing `findFirst … orderBy effectiveFrom desc` pattern; **default 50** when absent (zero-config).
- Productivity rendered as a new **section on the existing `/reports/classification` page** (no new route/nav).

## C. Changes
**Backend:**
- `modules/vehicles/classification.service.ts` — `getProductivity()` returns `{ days, dailyTarget, today{confirmed,target,remainingToTarget}, remainingUnclassified, recentAvgPerDay, projectionDaysAtRecent, projectionDaysAtTarget, velocity[], byReviewer[] }`. Velocity + reviewer breakdown via `$queryRaw` (hard-coded aliases; only the date-window bound is parameterized). `days` clamped 1–90 (default 14). Remaining backlog reuses `liveVehicleWhere`.
- `modules/vehicles/classification.controller.ts` — `@Get('productivity')` (`REPORT_VIEW`, `@Query('days')`).

**Frontend:**
- `apps/web/app/(dashboard)/reports/classification/page.tsx` — new "Productivity" section: StatCards (today vs target, avg/active-day, days-to-clear, remaining), a velocity list with inline bars, and a reviewer leaderboard table. Same ADMIN/MANAGER gate.

## D. Guardrails honored
- Read-only; no schema migration, no writes. Rule 3 (`resource-compatibility.checker`), scheduling, queue, ETA untouched.
- Raw SQL aliases hard-coded; no user-controlled SQL; `days` clamped. Reviewer names appear only in the managers-only report (no customer PII).

## E. Config note
Optional `BusinessRuleConfig` row to override the default target:
`ruleKey = "classification_daily_target"`, `valueJson = { "target": <number> }` (site-aware). Absent → default **50/day**.

## F. Tests / verification
- API: extended `classification.service.spec.ts` — default-50 vs config target, today/velocity/byReviewer shape, `days` clamp (1–90). `vitest run classification` + `tsc --noEmit` green; web `tsc` green.
- Live (managers): Reports → Classification Progress → Productivity; velocity sparse until confirmations accrue; FRONT_DESK gets 403 / no view.

## G. Approval gate
Not a Mandatory Review Trigger: read-only reporting over existing data; no schema/Rule-3/ETA/queue change. Normal feature CR.
