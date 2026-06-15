# CR-2026-034 — Digital Visual Inspection Form (ADR + Change Request — PLAN ONLY)

**Status:** ADR / PLAN — **for review. NOT implemented.** No schema, migration, API, or web code. No migration applied.
**Type:** ADR + Change Request — new core entities + new audited state machine + digital sign-off (CLAUDE.md §9). Additive. No new third-party dependency proposed for v1.
**Author:** Vincent Wilson · **Drafted:** 2026-06-15
**Source of truth:** [`docs/56_Visual_Inspection_Form.md`](56_Visual_Inspection_Form.md) (transcribed from `inspection form.webp`).
**Approval gate:** §9 — surfaced before any schema/migration/code. Phase C of the approved roadmap.

> Planning deliverable only. On approval each build phase runs: implement → verify → pause → commit (named files) → tag, one at a time. No queue/ETA/scheduling/service-catalog/complaints/Twilio/assignment changes; no weakening of service-order or check-in flows.

---

## 1. Context / Problem
Stakeholders want a **digital visual inspection** replacing the paper job-card check-off: a technician records a 3-state result per line, captures brake/tire measurements, raises findings → recommendations, the customer decides per recommendation, a **senior technician and the customer sign off**, approved items can become follow-up work, and the completed inspection is **preserved immutably** and audited.

## 2. Decision (ADR)
Introduce a **`VehicleInspection` aggregate** tied to a `ServiceVisit`, with child **`InspectionItem`** (3-state checklist lines), **`InspectionWheelMeasurement`** (per-wheel brake/tire numbers), **`InspectionRecommendation`** (findings + customer decision + optional follow-up link), and **`InspectionSignature`** (senior tech + customer). Checklist lines are **template-driven** (seeded from `docs/56`, version-snapshotted per inspection). A small **state machine** locks the inspection immutable at sign-off. All additive; no existing entity is modified beyond additive back-relations.

### Alternatives considered (rejected)
- **Free-text notes / reuse ServiceOrderItem** — rejected: no 3-state result, no per-line findings, no decision workflow, no sign-off, no immutability.
- **Hardcode the checklist in code** — rejected as the *primary* model (see §4) because the form will evolve and historical inspections must preserve the exact lines used.
- **One JSON blob per inspection** — rejected for the checklist/recommendations (not queryable/reportable); JSON is used only where it fits (see §4 wheel option B).

## 3. Proposed data model (additive)
**Enums:** `InspectionStatus { DRAFT, COMPLETED, SIGNED_OFF, CLOSED, CANCELLED }`, `InspectionItemResult { OK, FUTURE, IMMEDIATE, NOT_APPLICABLE }`, `BatteryTestResult { PASS, RECHARGE_RETEST, FAIL }`, `WheelPosition { LEFT_FRONT, RIGHT_FRONT, LEFT_REAR, RIGHT_REAR }`, `RotorOrDrum { ROTOR, DRUM }`, `CustomerDecision { PENDING, APPROVED, DECLINED, DEFERRED }`, `RecommendationSeverity { FUTURE, IMMEDIATE }`, `InspectionSignatureRole { SENIOR_TECH, CUSTOMER }`, `InspectionSignatureType { TYPED, DRAWN }`.

**`VehicleInspection`** — `id`, `inspectionNumber @unique` (INS-NNNNNN, generated in the create tx like CUST-/CMP-), `siteId`, `serviceVisitId`, `vehicleId`, `customerId`, `status @default(DRAFT)`, `templateVersion Int`, `performedByUserId?` (technician), battery: `batteryTestResult?`, `batteryFactoryCca? Int`, `batteryActualCca? Int`, flags `alignmentCheckNeeded`, `wheelBalanceNeeded`, `brakeInspectionPerformed @default(true)`, `priorBodyDamageNotes?`, `comments?`, sign-off mirrors `signedOffByUserId?/signedOffAt?`, `customerAckByUserId?/customerAckAt?`, `createdByUserId?`, timestamps. Back-relations on Site/ServiceVisit/Vehicle/Customer (additive, virtual).

**`InspectionItem`** — `id`, `inspectionId`, `category`, `label` (snapshot from template), `orderIndex`, `result InspectionItemResult @default(OK)`, `note?`. (Line results immutable once SIGNED_OFF.)

**`InspectionWheelMeasurement`** — `id`, `inspectionId`, `position WheelPosition`, `brakeLiningMm? Float`, `tireTread32nds? Int`, `wearPattern?`, `tirePressureBeforePsi? Int`, `tirePressureAfterPsi? Int`, `rotorOrDrum RotorOrDrum?`. (4 rows.) *(Option B if we want fewer tables: a single `wheelMeasurements Json?` on the inspection — rejected for v1 in favor of the queryable table.)*

**`InspectionRecommendation`** — `id`, `inspectionId`, `inspectionItemId?` (source line), `severity RecommendationSeverity`, `description`, `suggestedServiceTypeCode?`, `customerDecision CustomerDecision @default(PENDING)`, `decisionByUserId?/decisionAt?`, `resultingServiceOrderId?`/`resultingServiceOrderItemId?` (soft link when approved → work). 

**`InspectionSignature`** — `id`, `inspectionId`, `role InspectionSignatureRole`, `type InspectionSignatureType`, `typedName?`, `imageData?` (base64 data-URL for DRAWN), `signedByUserId?` (senior tech), `signedAt`. (`@@unique([inspectionId, role])` — one signature per role.)

**Template (checklist source):** `InspectionTemplate { id, version @unique, name, isActive }` + `InspectionTemplateItem { id, templateId, category, label, orderIndex, allowsNa }`. Seeded from `docs/56`. On create, the inspection **snapshots** the active template's items into `InspectionItem` rows and stores `templateVersion` → historical inspections are unaffected by later template edits.

## 4. Template-driven vs fixed (requirement #2)
**Recommendation: template-driven, seeded from `docs/56`, with per-inspection snapshotting.** The active `InspectionTemplate` (v1 seeded from the spec) defines the lines; each inspection copies them into `InspectionItem` at creation and records `templateVersion`. This keeps `docs/56` the source of truth, lets the checklist evolve without code changes, and preserves immutability/auditability of exactly what was inspected. A template-management UI is **deferred** (v1 seeds one active template; edits via a seeded migration/config). *(Lighter fallback if you prefer: a versioned code constant instead of template tables — simpler, but checklist changes need a deploy and there's no admin edit path. Recommend the template tables.)*

## 5. Sign-off method (requirement #3)
**Recommendation: support both; default by role.**
- **Senior technician** → **typed/authenticated acknowledgment**: they are logged in, so identity is established by auth — capture `signedByUserId` + `signedAt` + a typed name confirmation (`type=TYPED`). Gated by a dedicated `INSPECTION_SIGNOFF` permission (the "senior" gate is RBAC, since the schema has no seniority flag).
- **Customer** → **drawn signature** (canvas → base64 PNG in `imageData`, `type=DRAWN`) as the faithful digital equivalent of the paper "X____", with a **typed-name fallback** (`type=TYPED`, `typedName`) when drawing isn't available.
- Both stored in `InspectionSignature`; signatures are immutable once written.

## 6. Recommendation / customer-decision workflow (requirement #4)
`FUTURE`/`IMMEDIATE` items (or advisor-added findings) become `InspectionRecommendation`s (severity carried from the item). After senior sign-off, the advisor reviews recommendations **with** the customer and records a per-recommendation `CustomerDecision` (APPROVED / DECLINED / DEFERRED) with `decisionByUserId`/`decisionAt`. The customer then signs (acknowledgement). Decisions are audited.

## 7. Approved items → service work (requirement #5)
**In scope, explicit (not automatic).** For an `APPROVED` recommendation, the advisor can "Add to work order", which **reuses the existing service-orders module** to create/append a `ServiceOrderItem` (by `suggestedServiceTypeCode`) on the visit's service order, and sets `InspectionRecommendation.resultingServiceOrderItemId`/`resultingServiceOrderId` (soft links). **No change to the service-orders flow** — the inspection module only calls existing creation paths. If no service order exists yet, advisor creates one via the normal flow first. (Deferrable to a later sub-phase if you want the core inspection first.)

## 8. API endpoints (requirement #6) — module `apps/api/src/modules/inspections/`
| Method/path | Permission | Effect |
|---|---|---|
| `POST /inspections` | `INSPECTION_CREATE` | create DRAFT for a visit; snapshot active template → items + 4 wheel rows; gen INS-NNNNNN; history(null→DRAFT)+audit |
| `GET /inspections?siteId&visitId&status` | `INSPECTION_VIEW` | list (site-scoped; non-admin forced to own site) |
| `GET /inspections/:id` | `INSPECTION_VIEW` | full inspection + items + measurements + recommendations + signatures + StatusHistory timeline |
| `PATCH /inspections/:id` | `INSPECTION_EDIT` | edit line results/notes, wheel measurements, battery, flags, comments — **only while DRAFT** |
| `POST /inspections/:id/recommendations` | `INSPECTION_EDIT` | add a finding/recommendation (DRAFT) |
| `POST /inspections/:id/complete` | `INSPECTION_EDIT` | DRAFT→COMPLETED (validate every required line has a result) |
| `POST /inspections/:id/signoff` | `INSPECTION_SIGNOFF` | COMPLETED→SIGNED_OFF (senior tech signature) → **results immutable** |
| `PATCH /inspections/:id/recommendations/:rid/decision` | `INSPECTION_DECISION` | record APPROVED/DECLINED/DEFERRED (after SIGNED_OFF) |
| `POST /inspections/:id/recommendations/:rid/to-work-order` | `INSPECTION_DECISION` | create/append ServiceOrderItem for an APPROVED rec; link it |
| `POST /inspections/:id/customer-signoff` | `INSPECTION_DECISION` | capture customer signature; SIGNED_OFF→CLOSED |
| `POST /inspections/:id/cancel` | `INSPECTION_EDIT` | DRAFT/COMPLETED→CANCELLED |

Conditional `updateMany` for state transitions (race-safe); cross-site service guard on by-id ops (ADMIN bypass); DTO whitelisting.

## 9. Web screens (requirement #7) — `apps/web/app/(dashboard)/inspections/`
- **Fill screen** (`[id]/page.tsx`, technician): grouped checklist (Interior/Exterior, Battery, Under Vehicle, Under Hood) with OK/FUTURE/IMMEDIATE toggles + per-line note; battery test + CCA; per-wheel brake/tire grid; flags; prior-damage notes; comments; "Complete".
- **Sign-off** (senior tech): review (read-only) + typed acknowledgment → sign.
- **Customer review** (advisor + customer): recommendation list with APPROVED/DECLINED/DEFERRED, "Add to work order" on approved, then **customer signature pad** (drawn, typed fallback) → close.
- **Print view** (read-only, CSS print) for the customer copy.
- Entry points: from the visit / queue-ticket detail ("Start inspection") + a Complaints-style sidebar/section link. Tablet-friendly (technicians).

## 10. Print / export (requirement #8)
**v1: print-friendly web view** (read-only, `@media print` CSS) → browser "Print/Save as PDF". **No new dependency.** The body-damage **diagram** from `inspection form.webp` is presentation; **v1 captures prior damage as notes**; an interactive/annotated diagram is **deferred** (future sub-phase, possibly an annotated image — would need an image approach, flagged then). Server-side PDF generation (a PDF lib) is **out of scope** (new dependency → separate CR if ever needed).

## 11. Permissions / RBAC (requirement #9)
New: `INSPECTION_VIEW` (front-desk/advisor/tech/manager/admin), `INSPECTION_CREATE` + `INSPECTION_EDIT` (technician + advisor + manager), `INSPECTION_SIGNOFF` (**senior** — granted to MANAGER/ADMIN in v1, plus an optional senior-technician grant; this is the "senior technician" gate via permission), `INSPECTION_DECISION` (advisor/front-desk/manager — records customer decisions + customer sign-off). ADMIN via `Object.values`. (Exact role grants confirmed at build; the key point: sign-off is permission-gated, not a schema seniority flag.)

## 12. Audit / status-history (requirement #10)
`entityType='VehicleInspection'`. StatusHistory on every transition (null→DRAFT, DRAFT→COMPLETED, COMPLETED→SIGNED_OFF, SIGNED_OFF→CLOSED, →CANCELLED). AuditLog actions: `INSPECTION_CREATED`, `INSPECTION_COMPLETED`, `INSPECTION_SIGNED_OFF`, `INSPECTION_CUSTOMER_SIGNED`, `INSPECTION_RECOMMENDATION_DECISION`, `INSPECTION_REC_TO_WORK_ORDER`, `INSPECTION_CANCELLED`. History/audit written after the status write (matches every existing service). **Immutability:** after SIGNED_OFF, item results + measurements + signatures cannot change (service guards + no edit endpoints for that state); only recommendation decisions + customer sign-off proceed.

## 13. Tests (requirement #11)
Service: create snapshots template items + 4 wheels + INS number; PATCH allowed only in DRAFT (blocked after COMPLETED/SIGNED_OFF); complete validation; signoff locks results (post-signoff PATCH → BadRequest); race-safe transitions (conditional updateMany); recommendation decision flow; approved→work-order creates+links a ServiceOrderItem (mocked service-orders); customer sign-off → CLOSED; signature immutability + one-per-role; cross-site IDOR; RBAC matrix (tech can fill but not signoff; senior/manager can signoff; etc.); audit+history per transition (entityType parity). Web: checklist toggles, signature pad blocks empty, print view renders, manager/senior gating. Template seed test (lines match `docs/56` count/labels).

## 14. Risks & mitigations (requirement #12)
| Risk | Mitigation |
|---|---|
| Scope (largest CR yet) | Build in sub-phases (§15); core inspection first, work-order linkage + print last |
| Immutability bypass | Edits gated to DRAFT; post-signoff guarded in service; signatures write-once (`@@unique`) |
| Signature storage bloat | base64 in a dedicated `InspectionSignature` table (not the hot inspection row); size cap in DTO |
| Drawn-signature device support | typed-name fallback for the customer |
| Coupling to service orders | reuse existing creation path only; soft links; no service-order flow change |
| Template drift vs history | per-inspection snapshot + `templateVersion` |
| PII on print/customer copy | print view is staff-initiated; no public/token route; no new external send |

## 15. Build phases (requirement #13) — each: implement → verify → pause → commit → tag
- **C-1 Schema + migration + template seed** (enums + 6 entities + back-relations; seed active template from `docs/56`). *Migration applied only after this ADR is approved.*
- **C-2 API core** (create/get/list/patch/complete/cancel + recommendations add) + RBAC + audit + tests.
- **C-3 Sign-off + customer decisions** (signoff, decision, customer-signoff, signatures, immutability) + tests.
- **C-4 Web** (fill / sign-off / customer-review+signature / print) + sidebar entry.
- **C-5 Approved → work order** linkage + tests.
(Each sub-phase is its own commit/tag under the one-CR-at-a-time rule.)

## 16. Migration plan (requirement #14 — DO NOT APPLY YET)
Additive only: `CREATE TYPE` for the 9 enums + `CREATE TABLE` for `vehicle_inspections`, `inspection_items`, `inspection_wheel_measurements`, `inspection_recommendations`, `inspection_signatures`, `inspection_templates`, `inspection_template_items`; FKs to existing tables (RESTRICT for site/customer/vehicle/visit; SET NULL for soft links); back-relations are virtual (no `ALTER` on existing tables). Generated via `prisma migrate dev --name cr_2026_034_visual_inspection` **at C-1, after approval** (with a `pg_dump` first). A seed step inserts the v1 `InspectionTemplate` from `docs/56`.

## 17. Guardrails / approval
ADR + CR plan only — **no implementation, no migration until approved**. No change to queue/ETA/scheduling/service-catalog/complaints/Twilio/assignment-recommender; no weakening of service-order or check-in flows; `docs/56` stays the source of truth. **Mandatory review (§9).** On approval, start **C-1** (schema + migration + template seed), then pause for review before C-2.
