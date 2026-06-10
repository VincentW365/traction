# Change Request — Manual SharePoint Sync (safe repeat import/update)

**CR ID:** CR-2026-014
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-003 (customer/vehicle import), CR-2026-005 (jobs/visits import).

---

## A. Objective
Establish a controlled, repeatable process to re-import / update from SharePoint **without duplicating** customers, vehicles, or jobs, and **without clobbering staff work**. The importers are run manually (the SharePoint extract is a manual, point-in-time CSV — `docs/29` §3.3).

## B. Idempotency guarantees (verified)
- **Customers / Vehicles** (`import-customers.ts`) — deterministic keys: customer `BERT-C-${stableHash(dedupeKey(name,phone,id))}`, vehicle `SC-${plate}` / `SC-CONTACT-${id}`. `upsert` by `customerNumber` / `vehicleCode` + `ExternalSystemRef` upsert by `(system, entityType, entityId)`. Re-run = no duplicates.
- **Jobs / Visits** (`import-jobs.ts`) — visit deduped by `jobId` `ExternalSystemRef`; one `ServiceOrder` per visit (update-or-create). Import-derived **child rows** (technician assignments, pauses, reworks) are **deleted-then-recreated** for that order, so re-running never duplicates them.

## C. Change in this CR
`import-jobs.ts` — the per-job write (visit + order + child delete/recreate + `ExternalSystemRef`) is now wrapped in a **single `prisma.$transaction`** so a mid-job failure can't leave deleted-but-not-recreated children. (The delete-then-recreate reconciliation already existed; this only adds atomicity.) The child replacement is scoped to **that one `HISTORICAL_IMPORT` order** — it never touches live operational orders.

## D. Preservation guarantees (must hold on every re-sync)
- Vehicle re-import updates only make/model/year/fuel/transmission/drivetrain/engineNo/plate/customerId. It does **NOT** touch `serviceClass`, `weightClass`, or `VehicleClassification` → **staff classification work (CR-2026-008) is preserved**.
- Customer re-import does **NOT** touch `notificationOptIn*` → **consent is preserved**.
- Existing VINs are not overwritten (VIN set on create only).
- **Removals are ignored** — records dropped from the source are simply not updated; never auto-deleted (avoids destroying operational/audit data).

## E. Runbook (repeat sync SOP)
1. Re-extract from SharePoint to `customers.csv` / `jobs.csv` at repo root (manual; both are **gitignored** — never commit). Keep `VIN_DECODE_PROVIDER=STUB`.
2. **Dry-run** (default, no writes) and review the report:
   - `npx tsx apps/api/scripts/import-customers.ts`
   - `npx tsx apps/api/scripts/import-jobs.ts`
3. **Commit** in order (customers first, then jobs):
   - `npx tsx apps/api/scripts/import-customers.ts --commit`
   - `npx tsx apps/api/scripts/import-jobs.ts --commit`
4. **Verify**: `verify-import.ts`, `verify-jobs.ts` (read-only).
5. **Recovery**: each commit prints a batch id → `--rollback <batchId>`.

## F. Verification (this CR)
- `tsc --noEmit` (API) green; `vitest` (mapper tests) unaffected.
- **Scratch double-import regression** (fresh `bsop_scratch`): import customers+jobs; record child-row counts; simulate staff edits (set a vehicle `serviceClass`+`weightClass`, a CONFIRMED `VehicleClassification`, a customer opt-in); **re-run both imports**; assert **counts unchanged** (assigns 10,023 / pauses 1,564 / reworks 30; customers/vehicles/visits/orders identical) **and staff work preserved**. Result: **PASS**. Scratch dropped; `bsop_dev` untouched.

## G. Guardrails honored
No schema migration; no live-ops/scheduling/queue/ETA/Rule-3/resource-compatibility/classification-service changes; customers/vehicles importer logic unchanged (already idempotent). Source CSVs gitignored. Single-file code change: `import-jobs.ts` (transaction wrap).

## H. Approval gate
Touches an import write-path → reviewed as a CR. Not a Mandatory Review Trigger (no schema/Rule-3/business-rule change; preserves all staff work and consent).
