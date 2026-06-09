# Change Request — Jobs / Visits Historical Import

**CR ID:** CR-2026-005
**Author:** Vincent Wilson · **Date:** 2026-06-09
**Status:** DRAFT — design only, awaiting approval. **No implementation yet.**
**Builds on:** CR-2026-003/004 (customers/vehicles + `contactId → Vehicle` external refs). Baseline tag `save-point-post-contact-field-backfill`.
**Governance:** §9 (writes to core entities `ServiceVisit`/`ServiceOrder`; touches scheduling-adjacent data). Two additive enum values.

---

## 1. Summary
Import the 9,055 historical jobs from `jobs.csv` as **terminal, historical ServiceVisit (+ ServiceOrder)** records, linked to the already-imported customers/vehicles via the `CustomerNo → Vehicle` external refs. **Idempotent**, **dry-runnable**, batch-tagged. **Read-only to the live operation** — historical rows must never enter the queue/scheduler.

## 2. Source & join reality (grounded in the data)
- **Source:** `jobs.csv`, **9,055 rows** (git-ignored, PII). SharePoint item `Id` = the job key.
- **Join:** `job.CustomerNo.Id → ExternalSystemRef(SHAREPOINT_CONTACT_DB, externalId) → Vehicle (→ Customer)`.
- **Resolution:**
  - **7,966** jobs → resolve to a real imported Vehicle+Customer.
  - **33** jobs → linked but the contact is missing (unresolved).
  - **1,056** jobs → **no `CustomerNo` link at all**.
  - → **1,089 jobs need a fallback** (see §7). *(docs/29 §1.1 only anticipated the 33 — the 1,056 unlinked is an additional decision.)*
- **Status distribution:** Completed 8,914 · Cancelled 84 · Not Started 34 · In-Progress 14 · Pause 9.

## 3. CRITICAL guardrail — historical, not operational
Historical rows are written **directly via Prisma in terminal state** and must NOT:
- create `QueueTicket`s, enter the queue board, or appear in dispatch;
- invoke the scheduler / recompute / ranking / ETA / bay assignment;
- trigger notifications or reminders.
To make them filterable out of operational views, add **`VisitSourceType += HISTORICAL_IMPORT`** (additive) and import with terminal status. The importer calls **no** appointment/check-in/queue/scheduling services.

## 4. Target entities & mapping (per job)
| Target | Source | Notes |
| --- | --- | --- |
| **ServiceVisit** (1/job) | — | `sourceType = HISTORICAL_IMPORT`; `status` per §5; `customerId`/`vehicleId` from join or fallback (§7); `checkedInAt`/`arrivalAt` = `Created` (site-local); `mileageIn` = `CurrentMileage` (flagged unreliable); `oilBrandRequested` = `field_3`. |
| **ServiceOrder** (1/job) | timestamps | `status` per §5; `startedAt` = `JobStart`; `completedAt` = `End Time`/`EndTime2`; `notes` = `ServiceDetail(s)` + `Comment`. |
| **ServiceOrderItem** | `field_20–23`, `BRAKES0`, `Radiator`, `ServiceDetail(s)` | **Decision §8** (header-only vs best-effort mapping). |
| **TechnicianAssignment** | `field_6` (multi) | Resolve tech names (O.Josephs…) to the seeded `Technician` roster by normalized name; unknown → skip + flag. |
| **ServiceOrderPause / Rework** | `JobPause/Resume` (1,564), `Rectify*` (30) | **Decision §9** (populate vs defer). |
| **ExternalSystemRef** | job `Id` | `system = SHAREPOINT_JOB_SHEET` (new, additive), `entityType='ServiceVisit'`, `externalId = jobId` → idempotency + provenance. |

## 5. Status mapping
- `Completed` → ServiceVisit `CLOSED`, ServiceOrder `CLOSED`.
- `Cancelled` → `CANCELLED` / `CANCELLED`.
- `In-Progress` / `Not Started` / `Pause` (57 stale rows) → **Decision §10**: import as terminal (`CLOSED`, original status preserved in ref metadata) vs skip. Lean: **import as terminal** (they're 2.5-yr-old snapshots, not genuinely live).

## 6. Idempotency
- One ServiceVisit per job, keyed on `ExternalSystemRef(SHAREPOINT_JOB_SHEET, 'ServiceVisit', externalId=jobId)` → upsert; child rows (order/items/assignments/pauses) reconciled under it. Re-run = update, no duplicates. Batch-tagged (`importBatchId` in ref metadata) for rollback.

## 7. Fallback for the 1,089 no-real-customer jobs (must-decide)
- **33 unresolved-linked + 1,056 unlinked.** Both need a customer+vehicle (FK-required).
- **Lean:** a single per-site **`Historical — Unknown Customer`** placeholder customer, plus a **placeholder vehicle per job** (so each visit stays 1:1), every such ref/record clearly flagged `UNRESOLVED_SOURCE`. Do **not** block the import for them.
- Alternative: skip the 1,089 (import only the 7,966 resolvable). Recommend **not** skipping — they're real operational history.

## 8. Service-item granularity (must-decide)
Service detail is 48% free-text + sparse structured flags. Options:
- (a) **Header-only** — no `ServiceOrderItem`s; raw detail in `ServiceOrder.notes`. Simplest, lossless-as-text.
- (b) **Best-effort** — map structured flags + keyword scan → catalogue `ServiceType`s where confident; raw retained; unmapped → a generic `HISTORICAL` service type.
- **Lean:** (a) header-only for v1 (fast, no fuzzy mismatches); revisit if item-level analytics needed.

## 9. Pause/Rework ledgers (must-decide)
Populate `ServiceOrderPause` (1,564) + `ServiceOrderRework` (30) from `JobPause/Resume`/`Rectify*`, or defer. **Lean:** populate (tables exist from CR-2026-001; valuable history) — but only if timestamps parse cleanly; else flag and skip the row's ledger.

## 10. PII / sensitive handling
- Source (`jobs.csv`) stays git-ignored. `Comment`/`ServiceDetail(s)` may contain free-text PII → stored on records (authed), **not** in logs; dry-run report shows **counts only** (no raw comments). No engine numbers in jobs. Dry-run output to git-ignored `demo-output/`.

## 11. Target / staging
Single dev DB; **dry-run** (default, no writes) → **`--commit`** (terminal historical rows). No separate staging table (consistent with prior imports). ~9,055 visits + orders (+ optional items/assignments/pauses) ≈ tens of thousands of rows — batch in chunks; per-row failures isolated + flagged.

## 12. Rollback
Batch-tagged via ref metadata. Rollback deletes, in FK order: refs → pauses/rework → items → assignments → service orders → service visits (this batch only). Placeholder customers/vehicles created by the batch removed if orphaned. Original customer/vehicle import (batch `10b5c669`) untouched.

## 13. Dry-run report (counts only)
Resolution counts (resolved / unresolved-linked / unlinked); status-mapping counts; tech-resolution coverage; fallback counts; ledger parse coverage; flagged rows (by jobId + issue, **no raw comments**). Git-ignored.

## 14. Tests (synthetic fixtures)
- Job→visit/order mapping + status mapping; tech-name resolution; fallback path (unresolved/unlinked → placeholder); idempotency (run twice → no dupes); terminal-state + `sourceType=HISTORICAL_IMPORT` (never queued); dry-run writes nothing + no raw comments in report.

## 15. Out of scope
Reminders, notifications, live queue/scheduling, service-order *items* if §8=(a), and any change to existing customer/vehicle data.

## 16. Open decisions for approval
1. **Fallback (§7):** placeholder for the 1,089 (recommended) vs skip.
2. **Stale statuses (§5/§10):** import 57 non-terminal as terminal (recommended) vs skip.
3. **Items (§8):** header-only (recommended) vs best-effort mapping.
4. **Ledgers (§9):** populate pause/rework (recommended) vs defer.
5. Confirm two additive enum values: `IntegrationSystem += SHAREPOINT_JOB_SHEET`, `VisitSourceType += HISTORICAL_IMPORT`.
