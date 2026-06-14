# CR-2026-030 — Customer service history + "Due for Contact"

**Status:** IMPLEMENTED — pending review + commit (one-CR-at-a-time roadmap, Phase A / CR-B).
**Type:** Change Request (read-only / additive surfaces; **no schema change, no new dependency**).
**Author:** Vincent Wilson · **Drafted:** 2026-06-13
**Approval gate:** Not a CLAUDE.md §9 mandatory trigger (no schema/rule/dependency/auth change). Lightweight CR. Commit paused pending review.

---

## 1. Change Summary
Two surfacing features that reuse existing data/logic — no new tables, no new prediction logic:
- **Customer service history:** a new paginated endpoint `GET /customers/:id/service-history` and a richer "Visit & Service History" table on the customer detail page (date, vehicle, services performed, mileage in→out, source, status).
- **Due for Contact report:** a new manager-gated report page that reuses the existing `GET /maintenance/due-vehicles` engine (mileage-pattern + due-date forecasting via `calculateAverageDailyMiles`) to list customers approaching their next service, with a sidebar entry.

## 2. Why the Change Is Needed
Stakeholders asked to "show a customer's history, where the history and mileage build a pattern to know when to contact them." Investigation found the *prediction* already exists (maintenance reminders + `/maintenance/due-vehicles`) but is **not surfaced**, and the customer detail page showed only the last 10 visits with minimal detail. This CR exposes both without touching the scheduling/prediction engine.

## 3. Decisions
- **Derive, no snapshot table.** History comes straight from `ServiceVisit` (consistent with `calculateAverageDailyMiles`); a denormalized mileage-trend table is deferred (would duplicate truth).
- **History INCLUDES historical-import visits** (they are the customer's real past service and the mileage-pattern basis) and **EXCLUDES test-data sandbox rows** — i.e. `liveVisitWhere(true, false)` → `{ testDataRunId: null }`.
- **Separate endpoint**, not an overload of `findById` (keeps the detail payload lean; `findById`'s 10-visit summary is unchanged).
- **Reuse `/maintenance/due-vehicles` as-is** for the report (no new API; it already includes `vehicle.customer`).

## 4. Files / Modules Impacted
**API**
- `apps/api/src/modules/customers/dto/service-history-query.dto.ts` *(new)* — `limit` (1–100, default 20) + `offset` (≥0, default 0).
- `apps/api/src/modules/customers/customers.service.ts` — `getServiceHistory(id, limit, offset)`; imports `liveVisitWhere`.
- `apps/api/src/modules/customers/customers.controller.ts` — `GET /:id/service-history` (`CUSTOMER_SEARCH`).
- `apps/api/src/modules/customers/__tests__/service-history.spec.ts` *(new)* — 4 tests.

**Web**
- `apps/web/app/(dashboard)/customers/[id]/page.tsx` — paginated "Visit & Service History" (vehicle/services/mileage), Prev/Next.
- `apps/web/app/(dashboard)/reports/due-for-contact/page.tsx` *(new)* — manager-gated report (threshold mi/days inputs; reuses `/maintenance/due-vehicles`).
- `apps/web/components/sidebar.tsx` — "Due for Contact" nav entry (Management, ADMIN/MANAGER).

**Docs**
- `docs/52_CR_2026_030_Customer_History_Due_Contact.md` *(this file)*.

## 5. Rule Impact
**None.** No scheduling/queue/ETA/parts/transport rule touched. The due-for-contact report is a read-only view over the existing maintenance forecast; no prediction logic changed.

## 6. Schema / API Impact
- **Schema:** none.
- **API:** one new read endpoint `GET /customers/:id/service-history?limit&offset` → `{ items, total, limit, offset }`; each item = `{ id, visitedAt, status, sourceType, mileageIn, mileageOut, vehicle{ id, vehicleCode, plateNumber, label }, services[] }`. No change to `/maintenance/due-vehicles`. No permission changes (`CUSTOMER_SEARCH` / `REPORT_VIEW`).

## 7. Data Backfill
**Not needed** (read-only; no new columns).

## 8. Risks
| Risk | Mitigation |
| --- | --- |
| Large histories per request | Server-side pagination (default 10 on the page, max 100 on the API). |
| Showing sandbox/test rows in a real customer's history | `liveVisitWhere(true, false)` excludes `testDataRunId` rows; covered by a test asserting the where-clause. |
| Hiding real history by over-filtering | Historical-import visits intentionally INCLUDED (test asserts no `sourceType` filter). |

## 9. Tests / Verification
- **Unit (vitest, 4 tests):** where-clause (customer + `testDataRunId: null`, historical NOT filtered), `createdAt desc`, take/skip, limit/offset clamping, mapper (deduped services, `visitedAt` fallback, vehicle label, paginated shape). Full customers suite (40 tests) green.
- **Typecheck:** `@bsop/api` + `@bsop/web` green.
- **Live booted smoke:** DEFERRED — the dev stack is intentionally left stopped per the standing "don't restart unless asked" instruction. To run later: `GET /customers/:id/service-history` returns paginated history (incl. historical, excl. test data); `/reports/due-for-contact` renders the due list.

## 10. Proposed Effective Phase
Phase 1 (surfacing existing data). Second CR of Phase A "Quick Wins"; executed one CR at a time.

## 11. Approval Needed?
**Yes** (standard review), but **not** a §9 mandatory trigger — no schema/dependency/rule/auth change. Commit is paused; only the 8 files in §4 will be committed, then an annotated checkpoint tag. No push, no remote.
