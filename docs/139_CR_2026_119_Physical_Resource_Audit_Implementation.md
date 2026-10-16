# CR-2026-119 — Physical resource audit: implementation and verification report

**Date:** 2026-10-16
**Directive:** Service Centre physical resource audit — final layout, wash area and press confirmed by management (13 sections, 7 deliverables).
**Status:** Confirmed corrections implemented and verified. **Resource audit NOT complete** — §G lists exactly what still needs a person in the building, as the directive requires.

This follows the directive's §12 structure, A–G. Nothing is reported as verified unless it ran.

---

## A. Final physical resource register

| # | Physical area | Equipment seen | Classification | System record | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Position 1 | BendPak two-post lift | Mechanical lift bay | one of BAY-01/02/08/09/10 — **unmapped** | Lift rating unverified |
| 2 | Position 2 | Two-post lift | Mechanical lift bay | **unmapped** | Lift rating unverified |
| 3 | Position 3 | Drive-on runway lift | Runway lift bay | **no record yet** carries `runway` | Alignment equipment not confirmed |
| 4 | Position 4 | Two-post lift | Mechanical lift bay | **unmapped** | Lift rating unverified |
| 5 | Position 5 | Covered ground-level, no fixed lift | Pending — general/overflow | may be BAY-06/07, LT-01/02 or OVF-01/02 | Operational use unconfirmed; **zero capacity** |
| 6 | Position 6 | Drive-on runway lift | Runway lift bay | **no record yet** carries `runway` | Alignment equipment not confirmed |
| 7 | Position 7 | Covered ground-level, no fixed lift | Pending — general/overflow | as Position 5 | **zero capacity** |
| 8 | Position 8 | Two-post lift, unoccupied | Mechanical lift bay | **unmapped** | Lift rating unverified |
| W | Wash area (by Position 8) | Dedicated washing location | Vehicle Wash Bay | **PWASH-01 "Vehicle Wash Bay"** — PRIMARY, capability CLEANING only, `Wash area` | **Confirmed** (management, 2026-10-16) |
| P | Press corner (left-hand corner) | Bushing/bearings press | Specialised workshop equipment | **PRESS-01** — SUPPORT_EQUIPMENT, not schedulable, zero vehicle capacity, `Press corner` | **Confirmed** |

Ten physical references. Six fixed lifting stations, two ground-level positions, one wash area, one press. Not ten interchangeable bays, and the software now says so.

## B. Database reconciliation report

**Confirmed mappings (done):**

| System record | Physical | Change made |
| --- | --- | --- |
| PWASH-01 | Wash area | UNVERIFIED → PRIMARY_SERVICE_POSITION; capabilities none → [CLEANING]; name "Power Wash" → "Vehicle Wash Bay"; position "Wash area". Reused rather than creating a `WASH-01` duplicate, per the directive's own check-before-create rule. |
| PRESS-01 | Press corner | Created: SUPPORT_EQUIPMENT, `schedulingEnabled: false`, capacity 1 but never counted, on the dispatch board so its status can be set by hand. |
| MSHOP-EXT | Off-site | UNVERIFIED → SUPPORT_EQUIPMENT, category stays EXTERNAL. Distinct from the press, as required. |
| MJACK-01/02, STAND-01/02 | Tools | Already SUPPORT_EQUIPMENT; unchanged. |
| CLEAN-01 (service) | — | `requiredBayType` GENERAL → **CLEANING**. The catalogue change management approved in §5. |

**Unresolved (deliberately untouched):**

| System record | What is known | What is needed |
| --- | --- | --- |
| BAY-01, 02, 08, 09, 10 — "Heavy Lift" | Five records claim a heavy two-post lift; the building has **four** | Which four are Positions 1/2/4/8. The fifth is a duplicate, a runway lift mis-recorded, or history. **Not guessed.** |
| BAY-03 "Sedan Lift" | Recorded `sedan`/STANDARD; Position 3 is a runway lift | Whether BAY-03 *is* Position 3 (then `liftType` → `runway`), another position, or history. **Classification unchanged** (§2). |
| BAY-06, BAY-07 | `liftType: null`, STANDARD, yet PRIMARY+GENERAL — "were Bay 6/7 (TBD)" | Likeliest candidates for Positions 5/7. If so, they are **currently over-counted** as full service bays. |
| LT-01/02, OVF-01/02 | UNVERIFIED | Whether any is the same floor as Position 5 or 7 — one place, one record. |
| BAY-04 Mobile Lift, BAY-05 Power Jack | UNVERIFIED | Equipment unless each is its own usable position. |
| Legacy `WorkBay` BAY-01..06 (39/6/16/0/1/0 jobs) | History preserved; links `UNRESOLVED` | Link each to the physical position it was, or mark history. `docs/122` §1199: legacy BAY-01 ≠ resource BAY-01 by code. |

**Not done, and why:** no handwritten position number was assigned to any BAY code (§2 action 1); no lift was created on the existing database because the records that *are* those lifts exist and must be linked, not duplicated (§2, §8); no record carrying job history was deleted or merged (§2).

## C. Corrected baseline configuration

`scripts/configure-resource-baseline.ts` was rewritten. The eight-heavy-lift list is gone.

**What it now describes:** two-post lifts (`liftType: two_post`), runway lifts (`runway`), ground-level positions (no lift, UNVERIFIED), the wash bay (POWER_WASH, CLEANING only), the press (SUPPORT_EQUIPMENT, not schedulable), the external machine shop (EXTERNAL), jacks and stands (SUPPORT_EQUIPMENT), and legacy records (reported, never altered).

**Two modes, decided by the database it meets:**

- **Existing database** (lift records present): lift records are **not touched** — it prints them with their recorded position or "position NOT recorded", and tells the operator to link them on the Confirm Work Positions screen. Ground positions are **not created** (they may already exist as BAY-06/07, LT, OVF). Only the confirmed items change: wash, press, external, equipment.
- **Fresh database** (no lift records): creates the six lifting stations keyed by physical position (`LIFT-P1`… `LIFT-P8`, with the correct lift type, weight **STANDARD** because ratings are unverified, PRIMARY + GENERAL), the two ground positions as UNVERIFIED (zero capacity), the wash bay and the press. Creates nothing it cannot justify from the photographs. **No fictitious lifts.**

**Safeguards (§8):** dry run by default, `--commit` required; matched by stable code, skipped when already correct (idempotent — proven below); every write goes through `ResourceAdminService`, so it is validated and audited exactly as the screen's edits are; nothing deleted; `booking_capacity_mode` and the fixed limit read back at the end and reported unchanged; the "left for the walk" list printed every run.

**Execution order for production (do not reverse):** physical inventory ✔ → database reconciliation (this report) → corrected baseline (this script) → **dry run on production** → approval → `--commit` → verification (`pnpm resources:summary`, `pnpm deploy:check`).

**Rollback:** every change is an audited `ResourceAdminService` update; `PRESS-01` is the only created record and can be retired (`retire`, history kept) or `deleteIfUnused`; PWASH-01's prior state (UNVERIFIED, no capabilities, name "Power Wash") is in its audit history; CLEAN-01 can be set back to GENERAL via `PATCH /service-types/CLEAN-01`. A pre-run backup of `work_resources`, `resource_service_capabilities`, `work_bays` and `service_types` is still the correct precaution and is in the deployment checklist.

## D. Service compatibility matrix

| Service | Capability | Resources that can take it today | Status |
| --- | --- | --- | --- |
| Vehicle Cleaning (CLEAN-01) | CLEANING | **PWASH-01 Vehicle Wash Bay** | **Confirmed** — `resources:summary` item 12 now reads *DEDICATED_POSITION: a booked cleaning does not consume a repair position* |
| General mechanical work | GENERAL | BAY-01/02/03/06/07/08/09/10 (as recorded) | Requires confirmation — which are the four two-post lifts; 06/07 may be ground-level |
| Oil Change (OIL-01) | LUBE | none confirmed | Requires confirmation — which position(s) do oil changes (legacy BAY-03 LUBE carried 16 jobs) |
| Pre-Purchase Inspection (INSP-01) | INSPECTION | none confirmed | Requires confirmation |
| Wheel Alignment (TIR-02) | ALIGNMENT | **none** | **Stays unavailable** (§4) until an alignment station is seen; a runway lift alone does not grant it |
| Bushing/bearing pressing | (equipment) | PRESS-01, status-tracked | Confirmed as equipment; supports work *in* a bay, adds no bay |
| Light mechanical / overflow | — | Positions 5 and 7 | Pending; **contribute zero** until confirmed |

Compatibility is by capability and category, not by whether a car fits: the dispatch engine already refuses non-cleaning work on a POWER_WASH resource and cleaning work off it (`resource-compatibility.checker.ts`), and the hand-placement path now refuses mechanical-only work on the wash bay too.

## E. Updated Resources & Bays interface

| Field (§10) | Where it now lives |
| --- | --- |
| Physical Position | New column `work_resources.physical_position` (nullable, free text, never derived from the code); editable on Resources & Bays; shown beside the code on Confirm Work Positions, with "Position not recorded" when empty |
| System Resource ID | existing |
| Resource Name | existing |
| Resource Type | lift types now include **Two-post lift** and **Drive-on runway lift**; "None" reads "None (ground-level position)" |
| Supported Services | existing capability chips |
| Current Status | existing (AVAILABLE / TEMPORARILY_UNAVAILABLE / MAINTENANCE / OUT_OF_SERVICE) |
| Booking Eligible | existing `schedulingEnabled` |
| Capacity Contribution | existing `capacityRole`; the wash bay is now **reported apart** from service positions in readiness and in `resources:summary` ("Verified wash position (not service)") |
| Historical Bay Link | existing `legacyBayId` + dispositions |
| Last Modified | existing audit history |

**Physical Workshop Layout** (§10 recommended enhancement): a schematic on Confirm Work Positions showing Positions 1–8, the wash area and the press corner as the photographs number them, each slot showing its linked record or **"No record linked"**, two records on one slot flagged as a double-count, click-through to the record. It is a reference to existing records: it creates nothing. Linking is done by typing the position onto the record, under the same role-based authorisation and audit as every other resource edit.

## F. Testing report

**Automated:** API **1809 passed** (17 skipped) — 9 new cases for the transfer guard, 2 existing fakes extended; web **411 passed**; both typecheck configs clean; both builds clean; `deploy:check` PASS, no drift.

**Scenario E — corrected baseline against the representative test database (this machine), with before/after snapshots:**

```
resources 20 -> 21 | added: ["PRESS-01"] | removed: [] | duplicate codes after: []
changed: PWASH-01  UNVERIFIED, caps [] , name "Vehicle Wash Bay"
               -> PRIMARY_SERVICE_POSITION, caps [CLEANING], position "Wash area"
         MSHOP-EXT UNVERIFIED -> SUPPORT_EQUIPMENT (EXTERNAL)
legacy assignment counts unchanged: true   (BAY-01 39, BAY-02 6, BAY-03 16, BAY-04 0, BAY-05 1, BAY-06 0)
lift records untouched: true               (BAY-01/02/03/06/07/08/09/10 byte-for-byte)
CLEAN-01 now requires: CLEANING
Derived verified SERVICE positions: 8   (wash positions, counted apart: 1)
Public booking: mode "FIXED", fixed limit 2 — unchanged
second dry run: every item "already correct" — idempotent
```

**Scenarios A–D, live against the built API (2026-10-16), one WAITING ticket:**

```
D  lift → MAINTENANCE; assign          400  "Heavy Lift 1 is maintenance. Reason: …"   ✔
A  assign → lift                       201  "Assigned to Heavy Lift 1"; lift OCCUPIED; ticket CALLED   ✔
B  assign → wash, lift NOT released    400  "still at Heavy Lift 1 (BAY-01). Release it there before
                                             placing it here — it cannot be in two positions at once"   ✔
   release lift                        201  lift AVAILABLE
   assign → wash                       201  "Assigned to Vehicle Wash Bay"; wash OCCUPIED   ✔
   second assignment to the wash       400  "Resource PWASH-01 is currently occupied"   ✔
   release wash                        201  wash AVAILABLE
C  assign → press                      400  "Bushing/Bearings Press is not accepting scheduled work"   ✔
   press → MAINTENANCE                 201  operational-status MAINTENANCE, isOperational false   ✔
```

**A defect found by the live probe, and fixed:** the first B run failed — releasing the lift left the ticket in CALLED and `/assign` accepted only WAITING, so a vehicle could never be moved from a lift to the wash. The hand-placement guard now allows a mid-visit ticket (CALLED, IN_SERVICE), still refuses COMPLETED/CANCELLED, refuses a vehicle that is physically at another position (naming it), and refuses mechanical-only work on the wash bay. The unit spec covers the mechanical-only refusal; no live visit carried service items to exercise it live.

**One nuance, stated plainly:** at the resource level, MAINTENANCE blocks assignment (Scenario D above). Service-order assignment still goes through the legacy `WorkBay` table — the shadow-mode design of CR-108 — so a technician can still be assigned a *job* on a legacy bay whose parallel resource is in MAINTENANCE. The operational audit records this as expected behaviour; changing it is the resource-aware activation, which is gated.

**Things the test database could not show:** the fresh-deployment creation path of the baseline (this database has lifts, so it took the existing path by design — the fresh path is deterministic code, not probed); mechanical-only refusal at the wash bay live (covered by unit test).

## G. Outstanding confirmation report

The audit is **not complete**. These need a person in the building, and nothing here was assumed:

1. **Legacy and lift mapping** — which of BAY-01/02/08/09/10 are Positions 1, 2, 4, 8; what BAY-03 is; what BAY-06/07 are. Done by typing the position onto each record on Confirm Work Positions. The layout panel shows progress.
2. **Positions 5 and 7** — operational use, and whether LT-01/02 or OVF-01/02 are the same floor. Until then they contribute zero.
3. **Lift-rated capacities** — every lift is treated as STANDARD until its plate is read; raise to HEAVY on the screen, per lift.
4. **Wheel alignment** — no station confirmed; TIR-02 stays off online booking.
5. **Oil change and inspection positions** — OIL-01 and INSP-01 have no confirmed position; the services stay as they are until one is linked.
6. **BAY-04 / BAY-05** — equipment unless each is its own position.
7. **Permanent regression scenario** — the lift→wash transfer and the press refusal were verified live and by unit test; adding them to `pnpm audit:operational` as standing checks is a follow-up, not yet done.
8. **Production execution** — dry run → approval → `--commit`, after a backup. Not run against production from here.

**Preserved throughout:** fixed booking capacity 2, 80-minute duration, 20-minute interval, minimum notice, horizon, 3:00 PM latest start — all still configured in Settings and unchanged by anything in this CR.
