# Change Request — Pause / Resume / Rework UI

**CR ID:** CR-2026-011
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-001 (recording-only pause/resume/rework backend). Advances `docs/29` item 2.3.

---

## A. Objective
Give staff UI controls for the existing pause/resume/rework workflow. Technicians can pause/resume their current job; advisors/managers get full pause/resume/rework on the queue detail. Frontend-only — reuses the existing endpoints and preserves recording-only semantics.

## B. Approach (approved)
- **Frontend only.** No API/schema change. Uses the dedicated `/pause`, `/resume`, `/rework` endpoints (which capture reason + write ledgers), never the generic `/status`.
- Controls on **Technician "My Work"** (pause/resume) and **Queue detail** (pause/resume + rework-from-QC).
- Rework reason = preset dropdown + optional description; pause reason = `PauseReason` dropdown + optional notes.

## C. Changes
- `apps/web/lib/service-order-actions.ts` (NEW) — `PAUSE_REASONS` (mirrors `PauseReason`) + `REWORK_REASONS` (advisory preset codes).
- `apps/web/components/status-badge.tsx` — added `PAUSED` (orange), `IN_PROGRESS`, `QC`.
- `apps/web/app/(dashboard)/queue/[id]/page.tsx` — per-order **Pause** (IN_PROGRESS), **Resume** (PAUSED), **Rework** (QC) controls with inline reason forms; dedicated-endpoint mutations; invalidates `['service-orders']` + `['queue-ticket']`.
- `apps/web/app/(dashboard)/technician/page.tsx` — resolves the current job's active order (ticket → visit → `by-visit`), then big **Pause Work** (with reason) / **Resume Work** buttons; Complete is hidden while paused.

## D. Guardrails honored
- No files under `apps/api/` changed. `resource-compatibility.checker.ts`, scheduling, queue recompute, ETA, dispatch, Rule 3 untouched.
- Pause/resume remain recording-only (no scheduling/queue impact) — that behavior lives in the unchanged backend. Rework keeps its existing backend behavior (re-open from QC, sync visit, recompute) — unchanged by this CR.
- No new permission (reuse `SERVICE_ORDER_STATUS`). No new PII surfaced.

## E. Tests / verification
- `cd apps/web && npx tsc --noEmit` (green).
- Backend sanity: `cd apps/api && npx vitest run pause-rework` (unchanged, passing).
- Live E2E (local, record-and-revert): drive a service order IN_PROGRESS → pause (PAUSED + open `service_order_pauses` row) → resume (IN_PROGRESS + row closed); QC → rework (IN_PROGRESS, `completedAt` null, `service_order_reworks` row). `/queue/[id]` and `/technician` compile/serve; PAUSED badge renders. All test state reverted.

## F. Approval gate
Not a Mandatory Review Trigger: frontend-only over already-approved recording-only endpoints; no schema/Rule-3/scheduling/ETA change. Normal feature CR.
