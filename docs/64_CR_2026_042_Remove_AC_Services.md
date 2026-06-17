# CR-2026-042 — Remove A/C services (no longer offered)

**Status:** IMPLEMENTED. **Type:** Service-catalogue change — owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
"Remove the A/C services. We will not be offering A/C services."

## 2. Services removed
Two `ServiceType` rows, family **A/C**:
- **AC-01** — A/C Diagnostic
- **AC-02** — A/C Repair

## 3. Approach — deactivate, don't destroy
`ServiceType` is referenced by `AppointmentService` and `ServiceOrderItem` (FKs), so the platform's discontinue mechanism is the `isActive` flag, not row deletion:
- `GET /service-types` (public list + the admin Services page) filters `isActive: true`.
- Appointment booking (`resolveServiceTypeCodes`) requires `isActive: true` and rejects inactive codes.

So setting `isActive = false` removes A/C from **every** live surface (booking wizard, admin Services list, quote/booking validation) while preserving auditability and reversibility. (At time of change there were **0** appointment-services referencing A/C, so nothing historical was affected.)

## 4. Changes
| Where | Change |
|---|---|
| Dev database (`bsop_dev`) | `AC-01` / `AC-02` set `isActive = false`, each with an `AuditLog` entry (`SERVICE_TYPE_UPDATE`, reasonCode `SERVICE_DISCONTINUED`, system actor). |
| `prisma/seed.ts` | Removed the AC-01 / AC-02 entries so **fresh** databases never list them (replaced with a restore note). |
| `data/service_catalogue.csv` | Removed the two A/C rows. |
| `docs/04_Service_Catalogue.md` | Removed the two A/C catalogue rows and the "A/C repair" example under Complex Repair. |

## 5. Kept intentionally
- The **`A/C` family** value and the **`AC` skill code** remain as vocabulary (no schema change). With no service using them they are simply dormant; the `A/C` family will not appear anywhere because it has no active members.
- Illustrative "A/C repair" mentions in `docs/03_Business_Rules.md` / `data/business_rules.csv` are generic rule **examples** (not config) and are left as-is.
- Any historical A/C appointment-services/orders (none currently) stay intact for audit/reporting.

## 6. Restore (if A/C is ever offered again)
1. Re-add `AC-01` / `AC-02` to `prisma/seed.ts` and `data/service_catalogue.csv` (+ `docs/04`).
2. In an existing DB, set `isActive = true` for the two codes (or reseed a fresh DB).

## 7. Verification
- DB: `AC-01` / `AC-02` now `isActive=false`; active service-type count 31; audit entries written.
- No application source changed (catalogue is data/config) — API + web typecheck and test suites are unaffected.
- No code references AC-01/AC-02 (data-import, test-data, tests) — confirmed by search.

## 8. Governance
Operational catalogue/config change (no schema change, no scheduling-rule/priority change, no auth change). Not a §9 mandatory review trigger. Non-destructive and reversible; recorded as a CR for traceability.
