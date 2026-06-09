# Change Request — Customer + Vehicle Import (from SharePoint Contact Database)

**CR ID:** CR-2026-003
**Author:** Vincent Wilson · **Date:** 2026-06-09
**Status:** ✅ IMPLEMENTED & COMMITTED to `bsop_dev` (2026-06-09). Approved batch: `10b5c669-06b7-4d14-937a-5aab95c2c013` → 6,856 customers, 7,157 vehicles, 7,157 external refs, opt-in=false.

> ⚠️ **Failed first batch — do NOT treat as a source of truth.** An initial commit (batch `7e0a9c62-ca8b-45b1-8fd2-641646ffd85e`) was **defective** (vehicles created without VINs due to a non-existent `Vehicle.notes` field, and a duplicate-plate ref-uniqueness bug). It was **fully rolled back** (verified 0 customers/vehicles/refs) before the corrected re-import. Both bugs are fixed in the committed importer. If `7e0a9c62…` appears anywhere, ignore it.
**Governance:** §9-relevant (writes to core entities `Customer`/`Vehicle`; one additive enum value). Real customer **PII** involved — see §8.

---

## 1. Change Summary

A one-time, **idempotent**, **dry-runnable** importer that loads the SharePoint "Contact Database" (7,157 records) into the operational `Customer` and `Vehicle` tables, with the SharePoint contact Id preserved as an external reference so the 9,055 historical jobs can be linked **later** (jobs are out of scope here).

Scope is **customers + vehicles only** (per approved decision). No job/visit history import.

## 2. Source files / tables & verified join logic

- **Source:** `customers.csv` (7,157 rows) — extracted from SharePoint list `3340b46c-…` ("Contact Database") on the `BertsAutoCentralLogs` site. Git-ignored (PII).
- **Each row = one customer ⇄ one vehicle pairing** (a customer with N vehicles appears as N rows).
- **Join key (for the future job import):** `jobs.CustomerNo.Id == contact row Id`. Verified: **99.6%** of linked jobs resolve (3,718/3,728 distinct customers). The contact `Id` therefore identifies a **vehicle row**, so it will be preserved on the **Vehicle** (see §6).
- **Cardinality (profiled from real data):** `Title` (Customer ID code) is ~unique per row (7,103 distinct / 7,157) → **not** a customer-grouping key. `field_1` name has 6,721 distinct / 7,156 (~435 repeats). Phone 100%, email 58%, make/model/year 100%, plate 99.7% (21 missing), chassis/VIN 99.9%. 114 duplicate plates (incl. junk `0`).

## 3. Field mapping

### Customer (`customers` table)
| BSOP field | Source | Notes |
|---|---|---|
| `customerNumber` (unique, req) | derived | Deterministic from dedupe key (see §4), e.g. `BERT-C-<n>` or normalized phone. Must be stable across reruns. |
| `firstName` / `lastName` (req) | `field_1` (Customer Name) | Parsed (see §3.1); raw name retained in `notes`. |
| `phone` (req) | `field_2` (Contact No.) | Normalized (digits, keep country code). 100% present. |
| `email` (opt) | `field_11` | 58% present; null otherwise. |
| `notes` | composite | Raw name, source Title (Customer ID code), Loyalty No. (`field_12`), import batch id. |
| `notificationOptIn*` | — | Default per schema (`true`); **recommend defaulting to `false`** for imported historical contacts (no consent captured) — decision flagged. |

### Vehicle (`vehicles` table)
| BSOP field | Source | Notes |
|---|---|---|
| `vehicleCode` (unique, req) | derived | `SC-<normalizedPlate>`; fallback `SC-CONTACT-<contactId>` when plate missing/junk (keeps uniqueness). |
| `plateNumber` (req) | `field_6` (License #) | Normalized (upper, strip spaces/dashes). Junk (`0`) → treated as missing. |
| `vin` (unique, opt) | `field_8` (Chassis #) | Normalized; **null on collision/junk** + flag (do not crash the unique constraint). |
| `make` | `field_4` | |
| `model` | `field_5` | |
| `modelYear` | `field_3` (Year) | Parse to int; null if non-numeric. |
| `color` | — | Not in source → null. |
| `weightClass` / `serviceClass` | — | **Null** (not in source). serviceClass null = fail-safe (blocked from mobile jack until set at check-in — DMAIC Rule 3). |
| `customerId` | dedupe | FK to the resolved/created Customer (§4). |

Unmapped source fields (kept in `notes`/metadata, not modeled): Engine No. (`field_7`), Transmission (`field_9`), Fuel (`field_10`), Drivetrain (`field_13`), Loyalty No. (`field_12`).

### 3.1 Name parsing (best-effort, raw always retained)
- `"LAST, FIRST"` → lastName=before comma, firstName=after.
- Company indicators (`LTD`, `LLC`, `INC`, `&`, `SERVICES`, etc.) → firstName="", lastName=full company name.
- Multi-owner (`"A / B"`) → kept as a single Customer; full string in lastName + notes (no owner-splitting).
- Else → split on first space. Always store raw `field_1` in `notes`.

## 4. Dedupe strategy (customers with multiple vehicles)

The source has **no clean per-customer key** (`Title` ≈ per-row). Strategy:
- **Vehicle:** 1 per contact row (preserves the contact-Id ⇄ vehicle join exactly).
- **Customer:** dedupe by **`normalized(name) + normalized(phone)`** → genuine multi-vehicle owners (same name+phone) collapse into one `Customer` with multiple `Vehicle`s; everyone else stays separate.
  - Why name+phone (not phone-only): avoids wrongly merging household members who share a phone but have different names. Avoids merging namesakes who have different phones.
  - **Residual risk:** namesakes sharing a phone get merged; flagged in the dry-run for manual review (expected to be rare).
- **Decision to confirm:** accept name+phone dedupe (recommended), OR import 1 Customer per row (no merge, simplest but duplicates the ~52–435 multi-vehicle owners), OR a stricter/looser key.

## 5. Idempotency strategy (safe to rerun)

Deterministic keys + upserts, so reruns converge with no duplicates:
- **Vehicle** keyed on `ExternalSystemRef(system=SHAREPOINT_CONTACT_DB, entityType='Vehicle', externalId=<contactId>)` → upsert; one Vehicle per contact Id, guaranteed.
- **Customer** keyed on derived `customerNumber` (stable from the §4 dedupe key) → upsert.
- Each row processed in its own transaction; failures isolated and logged (don't abort the batch).
- An **import batch id** (uuid) stamped on created rows (`notes`/`ExternalSystemRef.metadata`) for rollback (§10).
- Rerun = update-in-place; never blind insert.

## 6. Preserving CustomerNo as an external reference

- Requires **one additive enum value**: `IntegrationSystem += SHAREPOINT_CONTACT_DB` (additive migration; no data change).
- For each imported Vehicle, create `ExternalSystemRef { system: SHAREPOINT_CONTACT_DB, entityType: 'Vehicle', entityId: <vehicle.id>, externalId: <contactId>, syncStatus: 'SYNCED', metadata: { title, importBatchId } }`.
- This is exactly the key the future **job import** will use: `job.CustomerNo.Id → ExternalSystemRef.externalId → Vehicle (→ Customer)`.
- Source `Title` (Customer ID code) also retained (customer `notes`) for traceability.

## 7. Plate / VIN normalization & edge cases

| Case | Count | Handling |
|---|---|---|
| Plate normalization | — | Uppercase, strip spaces/dashes; `vehicleCode = SC-<plate>`. |
| **Junk plate** (`0`, etc.) | ~9+ | Treat as **missing**. |
| **Missing plate** | 21 | `vehicleCode = SC-CONTACT-<contactId>` (keeps uniqueness); flag. |
| **Duplicate plate** | 114 | If same normalized plate already imported: attach the contact Id as an **additional ExternalSystemRef** on the existing Vehicle (don't create a 2nd vehicle); flag for review. Junk excluded first. |
| **VIN/chassis** | 99.9% | Normalize (upper, strip spaces). `vin` is unique → on collision or non-conforming junk, store **null + flag** (never break the constraint). |
| **Missing name** | 1 | Placeholder `lastName = "Contact <id>"`; flag. |
| **Multi-owner name** | some | Single Customer, full name retained; no splitting. |
| **Ambiguous dedupe merge** | TBD | Flagged in dry-run; not auto-resolved. |

## 8. PII handling & git-ignore

- Source (`customers.csv`, `jobs.csv`, `customers*.xml`, `Service Center*.csv`, `.docx`) are **already git-ignored** (verified).
- **Dry-run report + flagged-rows output contain PII** → write only to a **git-ignored** path (e.g. `demo-output/` — already ignored). Never to `docs/` or any tracked location.
- **Tests use synthetic fixtures only** — no real names/plates/phones committed.
- **Logs:** counts and ids only — never customer names/phones/emails in logs.
- Importer reads from the local git-ignored CSV; no network calls (VIN decode forced to STUB).

## 9. Target: production / staging / both

- There is currently a **single dev database** (`bsop_dev`); no separate production DB.
- **Recommended:** no separate staging *table*. Two **modes** instead:
  1. **`--dry-run`** (default): reads CSV, runs all mapping/dedupe/validation, writes **no** DB rows, emits the report (§11).
  2. **`--commit`**: writes into the operational `Customer`/`Vehicle` tables (dev), idempotent + batch-tagged.
- Rationale: 7k rows is small; a staging schema adds complexity without benefit at this scale, and idempotency + dry-run + batch-rollback give the safety a staging table would. (If a real prod DB is later introduced, same importer, dry-run first.)

## 10. Rollback plan

- Every created row is tagged with the **import batch id** (Customer/Vehicle `notes` + `ExternalSystemRef.metadata`).
- **Rollback script:** delete in dependency order — `ExternalSystemRef` (this batch) → `Vehicle` (this batch) → `Customer` (this batch, only if it has no remaining vehicles/visits). Guarded to touch **only** import-created rows (never manually-created or seed data).
- Nuclear fallback (dev only): `pnpm db:reset` + reseed (loses all dev data — last resort).
- Because the import is idempotent, a partial/failed run can simply be **re-run** rather than rolled back.

## 11. Dry-run report format

Written to a git-ignored path; two artifacts:
1. **`import-dryrun-summary.md`** — totals: contacts read; **customers** (create N / merge M / total distinct); **vehicles** (create / attach-to-existing); edge-case counts (missing name, missing/junk/duplicate plate, missing/dup VIN, multi-owner, ambiguous merges); projected final counts.
2. **`import-flagged-rows.csv`** — one row per issue (contactId, issue type, raw values, proposed action) for manual review.

No DB writes occur in dry-run.

## 12. Tests needed before execution

- **Unit (synthetic data):** name parser (LAST,FIRST / FIRST LAST / company / multi-owner / missing); plate normalization + junk detection; VIN normalization; `vehicleCode` generation + missing/duplicate fallback; dedupe-key generation; `customerNumber` derivation (stable).
- **Idempotency:** import a small fixture twice → identical row counts, no duplicates, same ids.
- **Edge cases:** missing name/plate, duplicate plate, duplicate/junk VIN → no crash, correct flags, unique constraints upheld.
- **Dedupe:** same name+phone across 2 rows → 1 Customer, 2 Vehicles; different phone → 2 Customers.
- **Join preservation:** after import, a sample `contactId` resolves via `ExternalSystemRef` to exactly one Vehicle (and its Customer).
- **Dry-run:** produces report, writes zero DB rows.
- All tests use **synthetic** fixtures (no real PII).

## 13. Open decisions for approval
1. **Dedupe key:** name+phone (recommended) vs 1-customer-per-row vs other.
2. **Notification opt-in default** for imported contacts: `false` (recommended — no consent) vs schema default `true`.
3. **Scope confirm:** customers + vehicles only; jobs/visits deferred to a separate CR.

---

## Appendix — Separate follow-up (NOT part of this import)

**FOLLOW-UP-001 — `walk-ins` Rule 5 consistency gap.** `walk-ins.service.ts` uses the old one-directional mileage check (`requiresMileage && !mileageIn → reject`) instead of the shared `assertMileageGate` helper, and has **no manager override**. Align it to the shared gate (bidirectional + audited override) for Rule 5 consistency. Small, independent change; tracked separately, **not required** for the import.
