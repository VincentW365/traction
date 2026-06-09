# 29 — Open Follow-ups Register

Tracking loose ends after the customer/vehicle import (baseline tag: `save-point-post-customer-vehicle-import`).
Owner: Vincent Wilson unless noted. Status: **Decision pending** / **Approved** / **Deferred** / **Open**.

---

## 1. Must decide before jobs/visits import

| # | Item | Status | Lean / Proposed approach |
| --- | --- | --- | --- |
| 1.1 | **Fallback for 10 unmatched customers / ~33 jobs** (jobs reference contact Ids absent from the Contact DB). | Decision pending | **Lean:** for those jobs only, attach a **historical-only placeholder** customer+vehicle, clearly flagged as an unresolved source reference (e.g. external ref marked `UNRESOLVED`). Do **not** block the whole jobs import for ~33 rows. |
| 1.2 | **Model/import the dropped contact fields** before layering job history. | ✅ **Approved → CR-2026-004** | **Add all, before jobs import:** `Loyalty No.`→Customer; `Fuel Type`, `Transmission`, `Drivetrain`, `Engine No.`→Vehicle. Additive nullable fields + idempotent backfill of the existing import. **`Engine No.` treated as sensitive** (authenticated-only, no logs, no raw values in dry-run/reports). See `docs/30`. |

## 2. Operational follow-ups before pilot

| # | Item | Status |
| --- | --- | --- |
| 2.1 | Imported vehicles have **null `serviceClass`/`weightClass`** → mobile-jack-blocked (Rule 3 fail-safe) until classified at check-in. Consider back-classification from make/model. | Open |
| 2.2 | All imported customers have **notification opt-in = false** → reminders/marketing won't reach them until consent is captured. | Open (by design) |
| 2.3 | **Paused-clock scheduling behavior** (bay hold / ETA / rank while paused) remains deferred (CR-2026-001 follow-up). | Deferred |

## 3. Governance / environment follow-ups

| # | Item | Status |
| --- | --- | --- |
| 3.1 | Pre-existing WIP (technicians, maintenance reminders, reporting, staff, availability, NHTSA, web admin, `permissions.ts`, `app.module.ts`) was **risk-reviewed but not line-by-line audited**. | Open |
| 3.2 | **NHTSA VIN-decode should default to STUB** in all non-production environments (currently live-unless-`STUB`; mitigated locally only). | Open |
| 3.3 | **SharePoint extraction is manual + point-in-time** (snapshot 2026-06-09). No automated re-sync. | Open |

## 4. Data-quality follow-ups

| # | Item | Status |
| --- | --- | --- |
| 4.1 | 474 imported vehicles have **no VIN** (385 missing in source + 89 duplicate-nulled). | Open (acceptable) |
| 4.2 | **Name parsing** is best-effort; companies/joint owners kept whole in `lastName`, raw name retained in customer `notes`. | Open (acceptable) |
| 4.3 | Historical **mileage** values in the job sheet are unreliable (some > 400,000); relevant when jobs are imported. | Open |

---

> Next action: await approval of this register, then start the jobs/visits import CR. Items 1.1 and 1.2 should be resolved in/with that CR.
