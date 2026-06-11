# CR-2026-020 — Test Data Sandbox + Cleanup Runner

| Field | Value |
|---|---|
| **CR ID** | CR-2026-020 |
| **Title** | Test Data Sandbox + Cleanup Runner |
| **Author** | Vincent Wilson |
| **Date** | 2026-06-11 |
| **Status** | **APPROVED AS DESIGN** — documentation only landed; implementation gated (T-a → T-b → T-c), each separately approved |
| **Type** | CR + ADR (Mandatory Review Trigger: additive schema on core entities + tooling that deletes data) |
| **Supersedes / relates** | Builds on CR-2026-006 (operational scope) and the historical-import CRs (2026-003/004/005). Independent of CR-2026-019 (catalog/service-mix). |

> **Document scope.** This file is the approved design of record. It contains **no code, no schema edits, no migration, and no data operations.** Implementation proceeds only in the gated sub-steps in §12, each paused for separate approval.

---

## A. Objective
Give an operator (Vincent) a **safe, repeatable way to populate local/staging with realistic test data**, exercise the platform end-to-end, and then **remove only that test run's data** — with zero risk to imported SharePoint/historical records, real operational data, or shared infrastructure.

End-to-end coverage targeted by a single run: customer creation → vehicle creation → appointment → walk-in → check-in → queue movement → service order → technician/bay assignment → pause/resume/rework → transport → payment-release gate → reports, including service-mix where applicable.

The test data must be: easy to identify, easy to clean up, **impossible to confuse** with imported or real operational data, removable **by run**, and **dry-runnable** before deletion.

## B. Inputs Used
- `CLAUDE.md` (operating directives, review triggers, guardrails), `docs/09_Data_Model.md`, `docs/21_Approval_Gates.md`.
- `prisma/schema.prisma` — FK/cascade graph (see §3), polymorphic tables, `IntegrationSystem` enum, `ExternalSystemRef` shape + `@@unique([system, entityType, entityId])`.
- `apps/api/src/common/helpers/operational-scope.ts` — the existing historical-exclusion pattern to mirror.
- Creation flows + guards: `customers.service.ts`, `vehicles.service.ts`, `appointments.service.ts` (+ check-in), `walk-ins.service.ts`, `queue.service.ts` (`callNext`, `abandonVisit`), `scheduling.service.ts`, `service-orders.service.ts`, `transport.service.ts`, `status.controller.ts` (`recordCompletion`), `prisma/seed.ts` (bays/resources/technicians).
- Importer script idiom: `apps/api/scripts/import-jobs.ts` / `import-catalog.ts` / `map-jobs.ts` (`dotenv` + `PrismaClient` + `has()/val()` args + dry-run/`--commit`/`--rollback` + batch-ref tagging).

## C. Assumptions
1. v1 is **local/staging only**. Production usage is disabled by default and must be explicitly enabled (§7).
2. Test runs are small (tens of entities); a single transaction for cleanup is acceptable.
3. The operator retains the `pg_dump` backup taken before a cleanup commit (restore is out-of-app).
4. Driving the **real domain services** during creation is acceptable and preferred (exercises real guards), even though it means tagging happens immediately after each create.
5. The pre-existing customer-number-generator fragility (it already throws on imported `C-…` numbers) is **out of scope** for this CR; we design around it (§2) rather than fix it.

---

## 1. Tagging model (LOCKED — hybrid)

**Hybrid = `TestDataRun` registry table + a small set of typed columns + a full `ExternalSystemRef` manifest.**

### 1.1 `TestDataRun` table (new, additive)
`@@map("test_data_runs")`:

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `label` | unique, e.g. `vw-test-run-2026-06-11` |
| `createdByUserId` | operator |
| `createdAt` | |
| `notes` | optional |
| `status` | `TestDataRunStatus` = `ACTIVE` \| `CLEANED_UP`, default `ACTIVE` |
| `cleanedAt` | set on cleanup commit |
| `creationSummary` | `Json?` — per-scenario created counts |
| `cleanupSummary` | `Json?` — per-table delete counts + backup path |
| timestamps | |

New enum `TestDataRunStatus { ACTIVE, CLEANED_UP }`.

The run row is **kept after cleanup** (`status = CLEANED_UP`) for audit; it is never deleted by the runner.

### 1.2 Typed columns (LOCKED — only three entities)
Add nullable FK **`testDataRunId String?` (→ `TestDataRun`, `onDelete: Restrict`), indexed, on exactly:**
- `Customer`
- `Vehicle`
- `ServiceVisit`

These three are the anchors and the tables that reports scope on; the column makes **reporting exclusion cheap** in both the Prisma-`where` and raw-SQL report paths (mirror of the historical pattern). **No other operational table gets a column.** Cleanup deletes the tagged rows first, so the `Restrict` FK never blocks (the run row survives).

### 1.3 `ExternalSystemRef(TEST_DATA_RUN)` manifest (LOCKED — all created rows)
Add enum value **`TEST_DATA_RUN`** to `IntegrationSystem`. For **every** row a test run creates (the three anchors **and** all descendants — appointments, queue tickets, orders, items, assignments, pauses/reworks, transport, parts, resource occupancies, classifications, and the polymorphic status/audit/notification rows the flows emit), the creator writes **one** `ExternalSystemRef` row:

```
system     = TEST_DATA_RUN
externalId = <testRunId>
entityType = <model name, e.g. "ServiceOrder">
entityId   = <row uuid>
metadata   = { label, scenario, createdAt }
```

The manifest is the **authoritative, graph-independent list** of exactly what to delete, and reuses the importers' existing batch-ref idiom. `@@unique([system, entityType, entityId])` guarantees one manifest ref per entity.

**Why hybrid:** columns → clean report exclusion; manifest → exact, auditable, graph-independent cleanup; visible name marker (§2) → human recognizability without touching the number generator.

---

## 2. Test customer numbering (LOCKED)
- Test customers keep **normal `CUST-NNNNNN` numbers** (created via direct `prisma.customer.create` with an explicit `CUST-` number).
- The **visible marker is the customer name prefix `VWTEST`** (e.g. `firstName = "VWTEST"`), which surfaces naturally in queue board / customer search.
- **Do NOT** use `VWTEST-` customer numbers.
- **Do NOT** modify the core customer-number generator (`customers.service.ts`) in this CR.

**Rationale:** `CustomersService.create` derives the next number via `MAX(CAST(SUBSTRING(customer_number FROM 6) AS INTEGER))` over **all** customers. A non-numeric segment (as a `VWTEST-…` number would produce) makes that cast throw — which would break **real** customer creation while test data exists. Keeping `CUST-` numbering eliminates that interaction entirely.

---

## 3. Schema impact summary (additive only — DESIGN, not yet applied)
One migration (`..._test_data_run`) would add: `TestDataRun` model, `TestDataRunStatus` enum, `testDataRunId?` on `Customer`/`Vehicle`/`ServiceVisit`, and `IntegrationSystem.TEST_DATA_RUN`. **No existing column or data is edited.**

### Cascade graph relied upon (from `prisma/schema.prisma`)
`onDelete: Cascade` already removes most children automatically:
- under `ServiceVisit` → `QueueTicket`, `QueueDecision`, `QueueEvent`
- under `ServiceOrder` → `ServiceOrderItem`, `TechnicianAssignment`, `PartsRequest` → `PartsRequestItem` → `PartsReservation`, `ServiceOrderPause`, `ServiceOrderRework`
- under `Vehicle` → `VehicleClassification`
- under `Appointment` → `AppointmentService`

`Restrict` relations (require explicit child-first delete): `Appointment`, `ServiceVisit`, `ServiceOrder`, `TransportRequest`, `ResourceOccupancy`, `ResourceReservation`, `InventoryTransfer`, `PosReference`, `MaintenanceRecommendation`, `MaintenanceReminder`, `VehicleSpecSnapshot`, `FluidSpecSnapshot`.

Polymorphic, no FK cascade (delete by `entityId IN (...)`): `StatusHistory`, `AuditLog`, `NotificationLog`, `ExternalSystemRef`.

---

## 4. Tables affected by a test run
- **Column + manifest:** `Customer`, `Vehicle`, `ServiceVisit`.
- **Manifest only:** `Appointment`, `AppointmentService`, `QueueTicket`, `QueueDecision`, `QueueEvent`, `ServiceOrder`, `ServiceOrderItem`, `TechnicianAssignment`, `ServiceOrderPause`, `ServiceOrderRework`, `ResourceOccupancy`, `TransportRequest`, `PartsRequest`/`PartsRequestItem`/`PartsReservation` (parts scenario only), `VehicleClassification`, plus the `StatusHistory`/`AuditLog`/`NotificationLog` rows the flows emit.
- **Never owned, never deleted (shared infra referenced by test rows):** `Site`, `UserAccount`, `ServiceType`, `WorkResource`/bays, `Technician`, `BusinessRuleConfig`, the historical/imported dataset, `ServiceCatalogItem`/`ServiceJobMapping`.

---

## 5. Test-data creation (design)
**Runner:** `scripts/test-data.ts create` — `dotenv` + `PrismaClient` + `has()/val()` args, **dry-run by default**, env-gated (`ALLOW_TEST_DATA_TOOLS=true`).
**Flags:** `--label <s>` (default `vw-test-run-<date>`), `--scenarios <csv|all>`, `--commit`.

**Approach:** create `Customer` + `Vehicle` anchors via **direct `prisma.*.create`** (explicit `CUST-` number, `firstName='VWTEST'`, set `testDataRunId`); then **drive the real domain services** for everything else (so the real guards/transitions run); then **tag** — set `testDataRunId` on the resulting `ServiceVisit` and write a `TEST_DATA_RUN` manifest ref for **every** created row. A post-create **graph-walk from the anchors** reconciles and reports any descendant left un-manifested.

**Scenario templates (`--scenarios`):**
1. **appointment** — customer/vehicle → appointment (tomorrow, within operating hours) → check-in → queue.
2. **walkin** — walk-in register (mileage per service requirement) → queue.
3. **waiting-parts** — order → `WAITING_PARTS` (status or pause) → resume.
4. **transport** — visit with a `transportEligible` service → transport create → confirm → schedule → assign driver → start → complete.
5. **unpaid-release-gate** — order to QC/ready, payment unpaid → `recordCompletion` **blocked** (demonstrates the P4c gate), left unpaid.
6. **completed** — full happy path → assign tech/bay → IN_PROGRESS → QC → READY_TO_INVOICE → mark paid → `recordCompletion` → CLOSED.
7. **abandon** — visit → `queue.abandonVisit` (exercises the P3 no-show/abandon transition).

**Guards respected during creation:** future datetime + operating hours + same-day cutoff (Rule 1), mileage gate (Rule 5), ARR-007 duplicate (distinct vehicles per concurrent visit), mobile-jack-sedan-only (Rule 3 — use sedans or `STAND-01`), payment-release gate (P4c). Seeded infra reused: bays `BAY-01..06`, resources `STAND-01/02`/`MJACK-01/02`, technicians `BERT-T01..T12`.

---

## 6. Cleanup (design) — dependency order
**Runner:** `scripts/test-data.ts cleanup --run <id>` — manifest-driven, single transaction, **dry-run by default**, `--commit` required, `--run <id>` mandatory.

Reads the manifest (`ExternalSystemRef` where `system=TEST_DATA_RUN AND externalId=runId`), groups `entityId` by `entityType`, runs all **safety assertions (§8)**, prints **exact per-table counts** (§9), then on `--commit` (after the backup gate) deletes in this order (cascades remove cascade-children automatically):

1. `NotificationLog` (by `entityId IN testIds`)
2. `MaintenanceReminder`, then `MaintenanceRecommendation`
3. `PosReference`
4. `InventoryTransfer`
5. `TransportRequest`
6. `ResourceOccupancy`, `ResourceReservation`
7. `ServiceOrder` *(cascades items / assignments / parts→items→reservations / pauses / reworks)*
8. `ServiceVisit` *(cascades queue tickets / decisions / events)*
9. `Appointment` *(cascades appointment_services)*
10. `VehicleSpecSnapshot`, `FluidSpecSnapshot`
11. `Vehicle` *(cascades vehicle_classifications)*
12. `Customer`
13. `StatusHistory`, `AuditLog` (by `entityId IN testIds`)
14. `ExternalSystemRef` manifest rows (the `TEST_DATA_RUN` refs themselves)
15. `TestDataRun.status = CLEANED_UP`, set `cleanedAt`, `cleanupSummary`
16. Write **one real (non-test) `AuditLog`** recording the cleanup (run id, label, counts, backup path) so the deletion itself is auditable.

---

## 7. Environment safety (LOCKED)
- New config `ALLOW_TEST_DATA_TOOLS` (default **`false`**). Both `create` and `cleanup` refuse unless it is `true`.
- Intended on in local/staging; off in production. The protected-data assertions (§8) are a second line of defense even if the flag is mis-enabled.

---

## 8. Safety rules (LOCKED — enforced before any delete)
- **Env gate:** refuse unless `ALLOW_TEST_DATA_TOOLS=true`.
- **Explicit run only:** refuse without `--run <id>`; refuse if `TestDataRun.status != ACTIVE`.
- **Scope only to the manifest** of that run — **never by customer name alone, never by date alone, never "all local data".**
- **Hard refuse if the delete set intersects protected data** → abort the whole transaction if it contains any:
  - `ServiceVisit.sourceType = HISTORICAL_IMPORT`,
  - the `BERT-HIST-UNKNOWN` placeholder customer,
  - any `HIST-UNRESOLVED-` vehicle,
  - any `ExternalSystemRef.system IN (SHAREPOINT_CONTACT_DB, SHAREPOINT_JOB_SHEET, AUTOMATE, SAGE)`.
- **Tag cross-check:** every `Customer`/`Vehicle` in the set must carry `testDataRunId = runId` (customers also `firstName='VWTEST'`); abort on mismatch.
- **Never delete shared infra** (Site / User / ServiceType / WorkResource / Technician / Bay / BusinessRuleConfig / catalog) — assert none are in the set.
- **Backup gate (LOCKED):** `--commit` requires and records a `pg_dump` snapshot first (path stored in `cleanupSummary`).
- **Atomic:** all deletes in one transaction; any anomaly → full rollback, nothing deleted.
- **Print exact counts by table before deletion** (dry-run is the default; counts are always shown).
- **No soft-delete / quarantine in v1.** Cleanup is hard-delete, only after explicit `--commit`.

---

## 9. Dry-run output format
Mirrors the importer dry-runs (console + `demo-output/` JSON):

```
TEST DATA CLEANUP — DRY RUN
Run: vw-test-run-2026-06-11  (id <uuid>, status ACTIVE, createdBy <user>)
Manifest entities: 142

Rows to delete (dependency order):
  notification_logs .............   3
  transport_requests ............   1
  service_orders ................   4   (+cascade: items 9, assignments 4, pauses 1, reworks 0)
  service_visits ................   6   (+cascade: queue_tickets 6, queue_events 18)
  appointments ..................   2   (+cascade: appointment_services 3)
  vehicles ......................   6   (+cascade: vehicle_classifications 4)
  customers .....................   6
  status_history ................  41
  audit_logs ....................  12
  external_system_refs (manifest) 142
  TOTAL rows ....................  XXX

Safety checks: PASS
  historical/imported in set ....   0   (BLOCK if > 0)
  shared infra in set ...........   0   (BLOCK if > 0)
  untagged customers/vehicles ...   0   (BLOCK if > 0)
Backup: required before --commit  ->  pg_dump bsop_dev > backup_<run>.sql
No rows deleted (dry run). Re-run with --commit to delete.
```

---

## 10. Restore / rollback (LOCKED)
- **Cleanup is hard-delete** → reversibility is the **pre-`--commit` `pg_dump` backup** (path recorded in `cleanupSummary`); restore = `psql < backup_<run>.sql`.
- **Creation is fully reversible in-app:** just `cleanup --run <id>`. Re-creation = re-run `create` with a new label/run id.

---

## 11. Reporting behavior (LOCKED)
- **Test data is excluded from operational reports by default.** `operational-scope.ts` gains a symmetric test-data exclusion: `liveVisitWhere`/`liveCustomerWhere`/`liveVehicleWhere` add `testDataRunId: null`; `liveVisitSql`/`liveCustomerSql`/`liveVehicleSql` add `AND <alias>.test_data_run_id IS NULL`; new `includeTestData = false` param mirrors `includeHistorical`.
- **Optional `includeTestData=true`** passthrough on reporting endpoints for **local/staging diagnostics only**.
- Service-mix historical analytics are already test-free (test orders are live → unmapped). The aggregate board excludes test rows the same way; per-token display/status pages are unaffected (single-visit).
- When no test data exists, `testDataRunId IS NULL` is a no-op — existing reports do not regress.

---

## 12. Implementation plan — gated sub-steps (LOCKED split)
Each sub-step: typecheck (API+web) + unit tests + dry-run + a disposable read-only smoke; **pause for separate approval**; commit only named files; **no push/remote**.

- **T-a — schema + env + operational-scope exclusion.** Add `TestDataRun`/`TestDataRunStatus`, `testDataRunId?` on Customer/Vehicle/ServiceVisit, `IntegrationSystem.TEST_DATA_RUN`, migration `..._test_data_run`; add `ALLOW_TEST_DATA_TOOLS` to env; extend `operational-scope.ts` (+ unit tests). Pause before `migrate deploy`.
- **T-b — creator + scenarios + manifest.** `apps/api/src/modules/data-import/test-data/{scenarios,manifest,guards}.ts` (+ tests) and `scripts/test-data.ts create`. Dry-run first; pause before any write.
- **T-c — cleanup runner + safety guards + backup gate.** `scripts/test-data.ts cleanup|list` with all §8 assertions and the §10 backup gate. Dry-run first; pause before any `--commit`.

### Files expected (by sub-step)
- **T-a:** `prisma/schema.prisma` (+ migration `..._test_data_run`) · `packages/config/src/env.ts` · `apps/api/src/common/helpers/operational-scope.ts` (+ tests) · optional `reporting.controller.ts`/`reporting.service.ts` `includeTestData` passthrough.
- **T-b:** `apps/api/src/modules/data-import/test-data/scenarios.ts`, `manifest.ts`, `guards.ts` (+ tests) · `apps/api/scripts/test-data.ts` (create).
- **T-c:** `apps/api/scripts/test-data.ts` (cleanup/list).
- **Deferred:** web badge for `VWTEST` rows; read-only `GET /admin/test-runs`.

---

## D./E. Impacted Modules and Data
- **Schema (T-a):** new `TestDataRun` table + enum; three additive nullable columns; one `IntegrationSystem` enum value. Additive, non-destructive.
- **Config:** `ALLOW_TEST_DATA_TOOLS`.
- **Reporting:** `operational-scope.ts` (+ optional controller passthrough) — default-excludes test data.
- **Tooling:** new `scripts/test-data.ts` + `data-import/test-data/*` helpers.
- **No changes** to queue ranking / ETA / scheduling / Rule 3 / transport / notifications / deployment / external parts-labor / POS — these are only *driven* as a test actor.

## F. Risks / Tradeoffs
- **Customer-number generator fragility** (primary) — already throws on imported `C-…`; mitigated by keeping `CUST-` numbering (no `VWTEST-` numbers; generator untouched). Pre-existing `C-` fragility is a separate item; verify current `create` behavior in `bsop_dev` before relying on it.
- **operational-scope change alters report outputs** to also exclude test data — *intended*; covered by tests; no-op when no test data exists.
- **Manifest completeness** — a forgotten manifest ref would orphan a row; mitigated by the post-create graph-walk reconciliation + scenario tests.
- **Deleting test `AuditLog`/`StatusHistory`** is acceptable (test audit); the cleanup action itself writes a real, non-test audit entry.
- **Backup discipline** — restore depends on the operator retaining the `pg_dump` snapshot (path recorded, storage external).
- **Env gate must hold in prod** — defaults false; protected-data assertions are the second line of defense.

## G. Tests / Validation
- Unit: `operational-scope` test-exclusion builders; cleanup dependency order; guard refusals (protected data, untagged, wrong status, missing `--run`/env); manifest collect-descendants completeness.
- Integration/smoke: `create` dry-run → `--commit` (staging) → reports show test data only with `includeTestData=true` → `cleanup` dry-run shows exact counts → backup → `--commit` → counts match, run `CLEANED_UP`, protected data untouched (row counts for historical/shared infra unchanged before/after).

## H. Approval Gate
**Mandatory Review Trigger** (additive schema on core entities + tooling that deletes data). The **design is approved**. This document is the docs-only deliverable. Implementation proceeds only via T-a → T-b → T-c, **each separately approved**, with dry-run-first and pause-before-write/-delete throughout. **No push/remote.**

## Guardrails (carried)
Additive/non-destructive schema only; pause before any DB write and before any deletion; cleanup dry-run first with `--commit` + `--run` + backup required; never touch historical/imported/SharePoint/AUTOMATE/SAGE data or shared infra; no PII in logs/exports; no changes to queue ranking/ETA/scheduling/Rule 3/transport/notifications/deployment/external parts-labor beyond driving them as a test actor; commit only named files; no push/remote.
