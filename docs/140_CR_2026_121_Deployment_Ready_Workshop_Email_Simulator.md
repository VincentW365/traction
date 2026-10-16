# CR-2026-121 — No review prompts after redeployment: the workshop seeded as confirmed, customer email live, Booking Simulator removed

**Date:** 2026-10-16
**Status:** Implemented, verified locally, committed to `master` (Render auto-deploys)
**Requested by:** Product owner (Bert's Auto Parts Service Centre)
**Supersedes in part:** `docs/138` (provisional reconciliation) and the `resources:baseline` script of `docs/139`

---

## A. Objective

The owner's instruction, in full:

> Remove the walk the shop checklist and all services should have mappings in the KPI mapping and wherever. Review and assign accurate mappings or ask me how it should go, the same for bays and resources. The goal is when the web app is deployed again all those prompts to do corrections or review information for services, bays and KPIs to be gone. The booking services were tested, please remove the booking simulator. Also ensure upon redeployment all bays are seeded and email should be able to be sent to an actual real person and not a test account. If possible, ensure customers who receive the booking link and the status link can view them on any wifi, not just Bert's network.

Six deliverables, each closed below: (1) the walk-the-shop checklist, (2) KPI mappings, (3) bays and resources, (4) the Booking Simulator, (5) customer email, (6) customer links on any network.

## B. Inputs used

- `CLAUDE.md` §3, §6, §9, §10; `docs/03_Business_Rules.md`; `docs/21_Approval_Gates.md`
- `docs/138`, `docs/139` (photographic audit and its implementation), `docs/136` (live-sending switch), `docs/135` (feature switches), `docs/134` (split access, Render)
- The live local database and the running API, probed before any change (readiness, KPI mapping, catalogue readiness, reconciliation, rule history)
- The owner's three answers of 2026-10-16 (§C.4–C.6)

## C. Facts established before changing anything

1. **KPI mapping.** 36 catalogue services; exactly one active service unmapped: `CABIN-FLT-01`, added by CR-2026-120 without a contribution policy. 0 provisional, 0 incomplete. The "N services not mapped" banner was that one row.
2. **Catalogue readiness.** No blockers. Only heuristic warnings (`DURATION_LONG` on ENG-02/RACK-01/SUSP-02; `NAME_AMBIGUOUS` on BEL-01/BELT-01, SHOCK-01/SUSP-02, OIL-FLT-01) — on the public-catalogue preview page, for services that are not offered online. Not prompts to correct; left alone and reported in §I.
3. **Bays.** The eight numbered positions existed only on the development machine as `BAY-01…10`, none identity-confirmed, six resources `UNVERIFIED`, all six legacy `WorkBay` rows `UNRESOLVED`. The production database had never received a lift. "Setup needed" on Settings came from `production.ready=false`: three public services had no verified position (INSPECTION, LUBE, ALIGNMENT) and the shadow-validation stamp was stale.
4. **Owner's answer — alignment:** *no alignment equipment.* Wheel Alignment (TIR-02) comes off online booking; it stays in the catalogue for staff.
5. **Owner's answer — positions 5 and 7:** *real work positions for ground-level general work.* Recorded on OVF-01/OVF-02; LT-01/LT-02 described the same two places and are retired; "Mobile Lift" (BAY-04) and "Power Jack" (BAY-05) are equipment.
6. **Owner's answer — kinds of work:** *any lift does any work.* Every lift: GENERAL + LUBE + DIAGNOSTIC + INSPECTION + TIRE. The six legacy bay rows are work-type lanes, not places — recorded as REPLACED; technician assignment keeps using them unchanged.
7. **Email — the finding that mattered most.** CR-2026-117 seeded `notifications_live_sending = false` and made the rule win over `NOTIFICATION_MODE`. Production had `NOTIFICATION_MODE=LIVE` (the preflight fails a production build on anything else), so the CR-117 deploy silently put production back into test routing: every customer email went to the test address and the send still showed as successful. This is the "test account" the owner was seeing.
8. **Customer links.** The code has been correct since CR-2026-106/110: every customer link is built from `PUBLIC_APP_URL`; the web app calls `NEXT_PUBLIC_API_URL`; the API build fails on a missing/LAN `PUBLIC_APP_URL` and the web build refuses to run on Render without `NEXT_PUBLIC_API_URL`. "Only works on Bert's wifi" is the deployment's environment, not the application.
9. **Shadow validator.** `pnpm booking:shadow-validate` had been failing on its first service since the CR-2026-111 duration consolidation (it selected services without the vehicle-class columns the resolver now requires). The two remaining readiness blockers were the stale stamp it could no longer refresh.

## D. What changed

### D.1 The workshop is seeded, as confirmed, on every deploy — `prisma/workshop-seed-data.ts`

Called from `prisma/seed.ts` (which Render runs on every deploy). Idempotent and deferential: a record is **created only when absent**; an existing record is **changed only while still in its never-classified state** (UNVERIFIED role / no confirmed identity / UNRESOLVED disposition). A manager's later decision on the Resources screens is never overwritten by a redeploy. Every write leaves the same audit actions the Resources screens leave (`RESOURCE_CREATE`, `RESOURCE_CAPABILITIES_SET`, `RESOURCE_IDENTITY_CONFIRMED`, `RESOURCE_UPDATE`, `RESOURCE_RETIRE`, `LEGACY_BAY_DISPOSITION`), actor = seeded manager account, note naming this CR and the audit.

| Record | Action | Result |
|---|---|---|
| `LIFT-P1`, `P2`, `P4`, `P8` | create if absent | two-post lifts, PRIMARY, identity confirmed, `physicalPosition` "Position N", GENERAL+LUBE+DIAGNOSTIC+INSPECTION+TIRE, weight STANDARD (rating unverified) |
| `LIFT-P3`, `P6` | create if absent | runway lifts, same as above, no ALIGNMENT |
| `OVF-01` → Position 5, `OVF-02` → Position 7 | classify while UNVERIFIED | OVERFLOW_SERVICE_POSITION, GENERAL, confirmed, renamed "Ground-level position N" |
| `LT-01`, `LT-02` | retire while UNVERIFIED | duplicates of 5 and 7; skipped (not retired) if a vehicle is on them |
| `STAND-01/02`, `MJACK-01/02`, `BAY-04`, `BAY-05`, `MSHOP-EXT` | classify while UNVERIFIED | SUPPORT_EQUIPMENT |
| `PWASH-01` | complete while incomplete | PRIMARY, CLEANING, "Wash area", confirmed |
| `PRESS-01` | create if absent | SUPPORT_EQUIPMENT, never scheduled, "Press corner" |
| legacy `BAY-01…06` | disposition while UNRESOLVED and unlinked | REPLACED, with a note; `status` untouched so technician assignment is unchanged |

`scripts/configure-resource-baseline.ts` and `pnpm resources:baseline` are **deleted** — two sources creating the same codes would be the duplication §3/§12 forbid. `docs/139` stays as the record of how the facts were established.

### D.2 KPI — `prisma/kpi-contribution-seed.ts`

`CABIN-FLT-01` → `INCLUDED_IN_BASE` / `NO_DURATION`, exactly as `AIR-FLT-01` beside it ("a filter under *filters* in the general-service breakdown"). Applied by the existing idempotent KPI seed. **Assumption A1** (§E).

### D.3 Prompts removed or made honest

- **Walk-the-shop checklist** — the "Show walk-the-shop checklist" button and panel on Confirm Work Positions are gone; `confirmationsRequired` and the fourteen-question `CONFIRMATIONS` list are removed from `ResourceTruthAuditService`. The walk is done and its answers are code.
- **Settings landing** — "Resource Readiness: Setup needed" and the Capacity card's "Needs setup" were statements about a scheduling mode nobody has chosen (booking stays FIXED/2). While the fixed limit is in use they now read **Shadow only** / **Fixed limit** (informational); **Ready** when the checks pass; "Needs setup" only if resource-aware scheduling is live and its checks fail.
- **Capacity settings panel** — "Setup needed" → "Not ready to switch on" (this is the page where that decision is made; the wording now says what it means).
- **CLI summary** — "the physical walk is incomplete" → "the resource inventory is not fully classified".

### D.4 Booking Simulator removed

Deleted: `apps/api/src/modules/booking-simulator/` (controller, service, module, UAT session, spec), `apps/web/app/(dashboard)/admin/testing/`, the sidebar entry, the Settings "Testing tools" section and both links, `BOOKING_SIMULATE` permission, the `/public/booking/uat/redeem` endpoint and the UAT cookie path through `confirm`, the `/book` page's launch-token exchange and banner, `UAT_COOKIE_CROSS_SITE` from `render.yaml`, the manual's simulator task and troubleshooting row. The rule `booking_simulator_enabled` is closed by migration so Settings shows no orphan row.

Kept on purpose: the feature-switch mechanism of CR-2026-116 (`@RequireFeature`, `FeatureFlagGuard`, `isFeatureOn`, `useFeatureEnabled`, `requiresRule` on Settings links) with an empty table and a fallback message — the next tool management wants switchable adds one line in two places. Also kept: `TestRecordResolver` and per-record capture (the data-import sandbox still tags `TestDataRun` records).

### D.5 Customer email goes to customers

- Migration closes the open `notifications_live_sending = false` row (history kept) and writes `true` for every site; seed default is now `true`. **The rule still wins over the environment**, so this restores what the owner had set with `NOTIFICATION_MODE=LIVE`.
- Mailbox credentials remain deployment config only (CLAUDE.md §10): `render.yaml` now lists `NOTIFICATION_MODE=LIVE`, `EMAIL_PROVIDER`, `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` so the Blueprint prompts for them.
- `deploy:check` gains an `EMAIL_PROVIDER` check: a **warning** (never a failed deploy) naming every variable when no real mail can leave the deployment. Without a mailbox a send is recorded as **SIMULATED** on the Notifications screen — visible, never delivered to the wrong place.

### D.6 Readiness stamped on every deploy

`pnpm booking:shadow-validate` is repaired (D.6a) and now runs after the seed in both `pnpm deploy` and the Render `buildCommand`, non-fatal (`|| echo`). It compares FIXED with RESOURCE_AWARE over 14 days of every public service, records disagreements, and stamps the current configuration. It decides nothing; the gate's checks are unchanged (§H).

D.6a — `scripts/shadow-validate.ts` selects services with `SERVICE_DURATION_SELECT` (the same select the public API uses) instead of a hand-written list.

### D.7 Wheel Alignment off online booking

Migration: `service_types.bookable_online = false` for `TIR-02`. The service stays active for staff bookings.

### D.8 Customer links on any network — nothing to change in code; an exact checklist (§G)

## E. Assumptions

- **A1.** `CABIN-FLT-01` is included in the General Service allowance like the air filter. If management regards it as extra technician time, change it on Setup → KPI Mapping to `ADDITIVE_STANDARD` with its catalogue minutes; the seed never overwrites a mapping that exists.
- **A2.** Lift weight ratings are unverified; all six lifts are created STANDARD. A manager raises a lift to HEAVY on Resources & Bays once the plate has been read.
- **A3.** Ground positions 5 and 7 take GENERAL work only (the owner's description "ground-level general work"). Add TIRE there if the floor says so.
- **A4.** The six legacy bay rows remain the rows technician assignment offers (BAY-01 General … BAY-06 Inspection). Moving technician assignment onto the position-keyed resources is a separate change (it touches service orders, the queue ticket page and dispatch) and is not in this CR.
- **A5.** Equipment rows (stands, jacks, press, external shop) are not identity-confirmed; only positions are counted by that check.

## F. Impacted modules and data

API: `public-booking` (controller/service/module/dto), `resources` (truth audit, summary wording), `common` (features, guard, flags), `health` spec, `app.module`, permissions. Web: `/book`, sidebar, settings landing + capacity panel, settings catalogue + spec, reconciliation page, `use-feature`. Data: `prisma/workshop-seed-data.ts`, `prisma/seed.ts`, `prisma/kpi-contribution-seed.ts`, migration `20261016150000_cr_2026_121_…`. Ops: `render.yaml`, `package.json` (`deploy`, `resources:baseline` removed), `scripts/deploy-check.mjs`, `scripts/shadow-validate.ts`, `scripts/resource-reconciliation-summary.ts`. Docs: manual (HTML + PDF rebuilt), this record.

## G. Owner / deployer checklist (Render — the boss)

Everything in code is done. These are environment values only the deployment holder can set. After setting them, **redeploy bsop-web once** (the two `NEXT_PUBLIC_*` values are baked at build time).

| Service | Variable | Value |
|---|---|---|
| bsop-api | `PUBLIC_APP_URL` | the public web address, https, e.g. `https://bsop-web.onrender.com` |
| bsop-api | `API_CORS_ORIGIN` | the same address, exact, no trailing slash |
| bsop-api | `NOTIFICATION_MODE` | `LIVE` |
| bsop-api | `EMAIL_PROVIDER` | `smtp` |
| bsop-api | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | the shop mailbox (587 + `SMTP_SECURE=false`, or 465 + `true`) |
| bsop-web | `NEXT_PUBLIC_API_URL` | `https://<bsop-api host>/api/v1` |
| bsop-web | `NEXT_PUBLIC_WS_URL` | `https://<bsop-api host>` |

Proof after deploy: Setup → Deployment shows the public URL reachable and `emailProvider: smtp`; Setup → Notifications → send a test; Settings → Notifications shows **Send Email to Customers: On**; open the booking link from a phone on mobile data.

## H. Risks / tradeoffs

- Live email defaults ON: as soon as the mailbox is configured, real customers receive confirmations and ready notices. That is the instruction. Reverting is one toggle in Settings → Notifications; the test recipient mechanism is intact.
- A tester who makes a real booking on `/book` now creates a real customer and sends a real email. The simulator's safe path is gone by request; the data-import sandbox remains the place for test records.
- Shadow validation in the build adds ~3 s and one `BusinessRuleConfig` row per deploy. If it fails, the build continues and readiness shows "no validation recorded" — accurate, not misleading.
- The seed classifies production records it has never seen (e.g. `STAND-01` is UNVERIFIED there). The guard is the state, not the code: a record a manager has already classified is skipped.

## I. Not changed, and why

- Catalogue `NAME_AMBIGUOUS` pairs (BEL-01 / BELT-01, SHOCK-01 / SUSP-02): deactivating a service is a catalogue decision; raised for the owner, not made.
- Legacy `WorkBay` as the technician-assignment lane (A4).
- Booking capacity: FIXED / 2 / DEFAULT, as before. Readiness being `ready` does not switch anything; activation remains a manager's deliberate decision.

## J. Verification (local, 2026-10-16)

- `pnpm --filter @bsop/api typecheck`, `pnpm --filter @bsop/web typecheck`: clean.
- API vitest (common, health, resources, public-booking, notifications, CR-111d boundaries): **50 files, 663 tests pass**. Web settings-catalogue spec: 38 pass.
- Migration applied; `notifications_live_sending = true` open, `booking_simulator_enabled` closed, `TIR-02.bookable_online = false`.
- Seed run 1: `6 created, 5 classified, 2 retired, 6 legacy bays closed out`. Seed run 2: `0 / 0 / 0 / 0, 25 left as they were` (idempotent).
- Audit rows naming CR-2026-121: CREATE ×6, CAPABILITIES_SET ×8, IDENTITY_CONFIRMED ×9, UPDATE ×4, RETIRE ×10 (incl. the eight local-only `BAY-0x` lifts retired through the API on this machine), LEGACY_BAY_DISPOSITION ×6.
- Shadow validation: 7 services × 226 slots = 1,582 compared, 0 oversold, 0 undersold, 0 incomplete; stamped `fd979f7a39c311d7`.
- `/resources/readiness`: **production.ready = true**, one warning (CLEAN-01 on a single position). `/kpi/mappings`: unmapped 0, provisional 0, incomplete 0. Reconciliation: unresolved bays 0, unverified resources 0. `pnpm resources:summary`: READY. `pnpm deploy:check`: PASS (local-only warnings for PUBLIC_APP_URL and EMAIL_PROVIDER, both expected on a laptop).
- `/notifications/capabilities`: `mode: LIVE`, `modeSource: SETTING`.
- Manual PDF rebuilt (7 sections, 37 tasks).

## K. Approval gate

- Resource records created and classified from management's own answers; booking rules, queue ranking and capacity mode untouched.
- The readiness gate's checks are unchanged; only the stamp is refreshed automatically.
- Live email default: a notification-routing default, reversible in Settings — recorded here as the owner's instruction of 2026-10-16.
- Simulator removal: feature removal, no rule change.
No item in `docs/21_Approval_Gates.md` is crossed; this record is the review artefact.
