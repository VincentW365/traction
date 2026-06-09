# Change Request — Additive Contact Fields + Idempotent Backfill

**CR ID:** CR-2026-004
**Author:** Vincent Wilson · **Date:** 2026-06-09
**Status:** DRAFT — design only, awaiting approval. **No implementation yet.**
**Depends on / precedes:** runs **before** the jobs/visits import. Builds on CR-2026-003 (customer/vehicle import, batch `10b5c669`).
**Governance:** §9 (additive schema on core entities `Customer`/`Vehicle`). `Engine No.` is sensitive operational data.

---

## 1. Summary
Add five previously-dropped Contact Database fields as **nullable, additive** columns and **idempotently backfill** the already-imported customers/vehicles. No new rows — updates existing records in place.

## 2. Field mapping & schema (all nullable, additive)
| Source (Contact DB) | Target | Column | Type | Normalization |
| --- | --- | --- | --- | --- |
| `field_12` Loyalty No. | **Customer** | `loyalty_number` | `String?` | Trim only (identifier — preserve source). |
| `field_10` Fuel Type | **Vehicle** | `fuel_type` | `String?` | Upper+trim; map known synonyms (e.g. GAS/GASOLINE→PETROL); **preserve raw if unmapped**. |
| `field_9` Transmission | **Vehicle** | `transmission` | `String?` | Upper+trim (AUTOMATIC/MANUAL/CVT…); preserve raw if unknown. |
| `field_13` Drivetrain | **Vehicle** | `drivetrain` | `String?` | Upper+trim (FWD/RWD/AWD/4WD); preserve raw if unknown. |
| `field_7` Engine No. | **Vehicle** | `engine_no` | `String?` | Trim only; **no semantic normalization**. **Sensitive** (see §5). |

Migration: `ALTER TABLE ... ADD COLUMN` ×5 (nullable, no default, non-destructive). No enums (keep `String` to preserve unexpected source values).

## 3. Mapper changes
- Extend `RawContactRow` + the planned Customer/Vehicle shapes with the five fields.
- Add pure normalizers: `normalizeFuel`, `normalizeTransmission`, `normalizeDrivetrain` (canonical-set mapping with raw fallback); `loyalty_number` and `engine_no` are trimmed/preserved verbatim.
- All normalizers are pure → unit-tested with synthetic fixtures.

## 4. Backfill (idempotent, no new rows)
- Re-run the existing importer in `--commit`; matches existing records by `customerNumber` / `vehicleCode` / `ExternalSystemRef` and takes the **UPDATE** path to set the new fields.
- **Preserve original batch lineage:** the backfill must **not** overwrite `ExternalSystemRef.metadata.importBatchId` on existing refs — rollback continues to target the original batch `10b5c669`. (Importer change: on re-run, ref upsert preserves existing `importBatchId`.)
- Rerun-safe: running twice yields identical field values and no duplicate rows.

## 5. `Engine No.` — sensitive-data handling (guardrail)
- **Authenticated access only.** Served solely via existing RBAC-guarded vehicle endpoints. **Explicitly excluded** from public projections (`status/[token]`, display board) — confirm those selects never include `engineNo`.
- **No logs:** never written to application logs.
- **No raw values in dry-run/reports:** the dry-run shows **coverage counts only** (e.g. "engine_no present: N/7157"); raw engine numbers appear in **no** report/CSV, even git-ignored.
- Raw PII/source files remain git-ignored (unchanged).

## 6. Dry-run report (before any DB write)
Field-coverage summary (counts only, no raw values), e.g.:
```
Backfill coverage (of 7,157 vehicles / 6,856 customers):
  loyalty_number present: N
  fuel_type present:      N   (normalized M, raw-preserved K)
  transmission present:   N
  drivetrain present:     N
  engine_no present:      N   (values redacted)
```
Written to git-ignored `demo-output/`. No `engine_no` raw values anywhere.

## 7. Tests (synthetic fixtures only)
- Mapping/normalization for each field (fuel synonyms, transmission/drivetrain canonicalization, raw-preserved fallback, loyalty/engine verbatim).
- **Backfill idempotency:** plan/import twice → identical field values, no new rows, batch lineage preserved.
- **Engine-No safety:** report/coverage builder output for a row with an engine number does **not** contain the raw value; engine number not present in any logged string.

## 8. Rollback
- Additive nullable columns → soft rollback = set the five fields to `null` (no row loss). Avoid dropping columns (destructive). Original import rollback (`--rollback 10b5c669…`) remains valid.

## 9. Guardrails honored
Nullable/additive only · migration non-destructive · normalize-with-raw-fallback · Engine No. authed-only/no-logs/no-raw-reports · PII/source git-ignored · mapper updated + idempotent backfill · dry-run + coverage counts before writes · synthetic tests.

## 10. Open decisions for approval
1. Confirm the five column names/types (§2).
2. Confirm `engine_no` handling (§5) is sufficient, or whether stricter (e.g. column-level encryption) is wanted — **recommend not** for pilot (adds complexity; authed-only + no-logs is proportionate).
3. Confirm backfill preserves the original batch id (§4) rather than re-tagging.
