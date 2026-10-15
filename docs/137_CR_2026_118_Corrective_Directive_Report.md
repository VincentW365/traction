# CR-2026-118 — Corrective Development Directive: report

**Date:** 2026-10-15
**Directive:** Customer accessibility, mobile functionality, job navigation, customer display, technician experience (six issues)
**Status:** Issues 3, 4, 5, 6 code-complete and verified locally. Issues 1 and 2 are deployment corrections — code was already correct; verification needs the live environment and is **outstanding**. Device testing for Issue 3 is **outstanding**.

This report follows the structure the directive asks for in §11. Nothing below is
presented as verified unless it was actually run.

---

## A. Issue resolution summary

### Issue 1 — Customer booking links inaccessible outside the network · CRITICAL

| | |
| --- | --- |
| **Original problem** | Booking link opens only on Bert's network. |
| **Confirmed root cause** | **Deployment, not code.** The web app resolves the API from `NEXT_PUBLIC_API_URL`, which Next.js bakes in *at build time*. When it is unset, every public page falls back to `window.location.hostname:3001` — the LAN convenience. On Render the web and API are different hosts, so the page *loads* (HTML is served) but every API call goes to `bsop-web.onrender.com:3001`, which does not exist. That is exactly "opens but doesn't work". `render.yaml` already documents this as a "set after first deploy, then redeploy web" two-step; the symptom means the web service was built before the variable existed. |
| **Corrective action** | None needed in code. CR-2026-110 (`docs/134`) already made every customer link come from `PUBLIC_APP_URL`, gated the internal APIs, and refused wildcard CORS; `apps/web/next.config.ts` already **hard-fails a Render production build** without `NEXT_PUBLIC_API_URL`. Confirmed both during this review. |
| **Files** | None changed. Verified: `apps/web/next.config.ts`, `apps/web/lib/api-client.ts`, `apps/web/lib/public-api.ts`, `apps/web/app/status/[token]/page.tsx`, `scripts/deploy-check.mjs`, `render.yaml`. |
| **Testing** | Code-level: `publicUrl()` confirmed as the only builder of customer links (5 callers). Build guard confirmed present. **External access NOT verified** — cannot be done from this machine. |
| **Final status** | **Outstanding — infrastructure.** See §D. |

### Issue 2 — Customer vehicle-status links inaccessible · CRITICAL

| | |
| --- | --- |
| **Original problem** | Same as Issue 1 for `/status/<token>`. |
| **Confirmed root cause** | Identical mechanism — same API-base fallback. |
| **What already holds** | Per-visit unguessable token; `NotFound` ("This link has expired or is invalid") on expiry or terminal visit; the status page reads the real `ServiceVisit`/`ServiceOrder` (no parallel status system); estimate labelled "Est. completion", never a promise; email links come from `publicUrl()`. |
| **Corrective action** | None in code. One note for management: the status page currently **masks** the plate (`***` + last 4) by an earlier privacy decision. The directive asks for the registration to be shown. Left as-is pending a one-line decision (§E). |
| **Final status** | **Outstanding — infrastructure**, same step as Issue 1. |

### Issue 3 — Tablet camera does not open · HIGH

| | |
| --- | --- |
| **Original problem** | "Take Picture" behaves like a desktop file picker. |
| **Confirmed root cause** | Three, compounding. (1) Every photo control was a hidden `<input type="file" accept="image/*" capture="environment">`. `capture` is a *hint*: iPad Safari honours it; Chrome on Android tablets, Chrome on iPad, Samsung Internet and kiosk webviews treat it as a plain file picker. (2) No preview — the first file chosen was uploaded immediately. (3) The server captures EXIF orientation (`image-inspection.ts`) and then **drops it** — `InspectionPhoto` has no orientation column — while also stripping EXIF for privacy, so portrait photos arrived sideways. |
| **Corrective action** | New reusable `components/camera-capture.tsx` behind the pre-inspection's existing **Take Photo** / **Upload Image** buttons — same two buttons, same place, same names; only what they do changed. Take Photo: live camera via `getUserMedia` (rear first, front/rear switch when available) → shutter → preview with **Retake / Use Photo / Cancel**; `<input capture>` as the fallback when the live camera is refused or unavailable. Upload Image: a plain picker with no capture hint. Orientation baked into the pixels on the device via `createImageBitmap(file, { imageOrientation: 'from-image' })` so server-side EXIF stripping is harmless; downscale to 1600 px longest edge; permission / no-camera / in-use errors explained in plain words. Old unused `photo-capture.tsx` removed. **Scope note:** the Vehicle Inspection form has no photo section; one was added during this work and then **reverted at the owner's instruction** — the sheets and forms are finished and are not to change. |
| **Files** | `apps/web/components/camera-capture.tsx` (new), `apps/web/components/__tests__/camera-capture.spec.ts` (new), `apps/web/app/(dashboard)/inspections/[id]/page.tsx` (photo control only), `apps/web/components/photo-capture.tsx` (deleted). |
| **Testing** | 5 unit tests on the error explanations. Typecheck + build clean. **Not tested on a physical tablet** — see §E. |
| **Final status** | Code-complete. **Device verification outstanding.** |

### Issue 4 — Forms return to the Inspections list · HIGH

| | |
| --- | --- |
| **Original problem** | Back from a job sheet / inspection lands on the general Inspections page. |
| **Confirmed root cause** | Both forms hardcoded `<Link href="/inspections">← Inspections</Link>`, and both inspection forms did `router.push('/inspections')` on cancel. No notion of origin existed anywhere. |
| **Corrective action** | `lib/return-to.ts`: the origin travels as `?from=<path>`; the back control reads it, **names the destination** ("← Back to Job", "← Back to My Job", "← Back to Visit Record"), and falls back to the document's own **visit** when absent (§5.4F) — never a general page. `from` is validated as a root-relative internal path only (rejects schemes, `//host`, backslashes, control characters). All eight entry points now pass their origin: queue ticket (4 sites), technician job workspace (2), visit record (5), Inspections list (3, so a list open returns to the list). Sibling Job Sheet ↔ Inspection links carry the origin along. `lib/unsaved-changes.ts` (§5.4E): `beforeunload` while dirty plus a leave-check on the back link — the forms previously only saved on *Complete*. |
| **Files** | `apps/web/lib/return-to.ts`, `apps/web/lib/unsaved-changes.ts`, `apps/web/lib/__tests__/return-to.spec.ts` (new); `inspections/[id]/page.tsx`, `inspections/job-sheet/[visitId]/page.tsx`, `inspections/page.tsx`, `queue/[id]/page.tsx`, `technician/jobs/[orderId]/page.tsx`, `visits/[id]/page.tsx`. |
| **Testing** | 16 unit tests (validation, round-trip through a URL, labels). Both form routes confirmed dynamic in the Next build (no Suspense issue with `useSearchParams`). Hook ordering verified against early returns. |
| **Final status** | Code-complete. |

### Issue 5 — Licence plates on the customer display · MEDIUM-HIGH

| | |
| --- | --- |
| **Original problem** | Lobby screen shows ticket numbers only. |
| **Confirmed root cause** | Plates were *deliberately* excluded from the public projection (privacy). Also found: the Ready lane had **no time cutoff** (a collected car whose visit was never closed stayed up all day). |
| **Corrective action** | API: `plate` on every row, through a pure `presentPlate()` — never fabricated (null when unrecorded), normalised (upper-case, single spaces, no punctuation), masked to the last three characters when asked. Three business rules, all in Settings → Workshop Operations → Customer display board: **Show Licence Plates** (on), **Mask Licence Plates** (off), **Keep Ready Vehicles Listed For** (4 h). Ready lane now ages out. Screen: plate is the largest text on every card, ticket number beneath; "No plate recorded" fallback; **Quality Check** shown by name; ~5 rows per lane with slow page cycling and a "Showing 1–5 of 9" indicator beyond that; estimate shown only when one exists. Live push on close was already in place (close-visit recomputes). |
| **Files** | `apps/api/src/modules/queue/queue.service.ts`, `apps/api/src/modules/queue/__tests__/present-plate.spec.ts` (new), `prisma/migrations/20261015120000_cr_2026_118_display_board_plates/`, `prisma/seed.ts`, `apps/web/lib/settings-catalogue.ts`, `apps/web/app/display/[token]/page.tsx`. |
| **Testing** | 7 unit tests on the presenter. **Live, against the built API** (§C). |
| **Final status** | Code-complete and verified. |

### Issue 6 — Welcome message shows only an initial · MEDIUM

| | |
| --- | --- |
| **Original problem** | "Welcome, J". |
| **Confirmed root cause** | Two layers. (1) `user?.fullName?.split(' ')[0]` in *two* places (`/` dashboard and `/technician`), intended as "first name". (2) **Twelve accounts are stored as initial-plus-surname** ("J. Walters", "D. Dennis", …), so the first word *is* "J.". A correct UI cannot produce "Jason" from data that never contained it. And the Staff screen had **no way to edit a name** — the API accepted `fullName` on `PATCH /staff/:id`; the UI never offered it. |
| **Corrective action** | Both greetings show the whole recorded name with the §7.4D fallback ("Welcome to your Technician Workspace" when none). Technician header restructured: *Welcome back, {name}* / *Your Service Centre workspace* / *Technician · Service Centre · date*. Staff page gained an **Edit name** control (audited as `STAFF_UPDATE`). **No names were fabricated**; entering real first names is a manager data task via that control. |
| **Files** | `apps/web/app/(dashboard)/page.tsx`, `apps/web/app/(dashboard)/technician/page.tsx`, `apps/web/app/(dashboard)/admin/staff/[id]/page.tsx`, `apps/web/__tests__/cr-2026-103-surfaces.test.ts`. |
| **Testing** | Surface test now asserts the whole-name path and forbids the `split(' ')[0]` pattern. Rename path exercised live on a test account and restored (§C). |
| **Final status** | Code-complete and verified. Data correction outstanding — manager task. |

## B. Implementation details

- **Routing:** origin-carrying `?from=` on document links; validated internal-path-only; visit fallback. No route changes.
- **Frontend:** one reusable camera control; display page leads with plate and pages per lane; greetings use the full name; Staff name editor.
- **Backend:** display projection carries `plate` (and nothing else about the vehicle); three display rules read per request with safe defaults; Ready lane cutoff. No change to the ETA model, queue ranking, or any status machine.
- **Schema:** none. One data migration seeds three `BusinessRuleConfig` rows per site (idempotent).
- **Configuration:** nothing new required in production for Issues 3–6. Issues 1–2 need the existing variables actually set — §D.

## C. Testing evidence

**Automated:** web **411 / 411**, API **1800 passed / 17 skipped**, both typecheck configs clean, both builds clean, `deploy:check` PASS (migrations applied, no drift). New tests: 16 (return-to) + 5 (camera errors) + 7 (plate presenter); 3 existing surface tests updated to the corrected wording.

**Live, against the built API, 2026-10-15:**

```
GET /display/<token>  (no auth)
  showPlates: true · first row keys: ticketNumber,plate,position,estimatedStart,
  estimatedCompletion,publicState,showRange · sample plate "ABC1234"
  PII scan of the whole payload (phone|email|firstName|lastName|vin): none

Mask Licence Plates → ON  (via Settings PATCH)   plates: ["••••234"]  all masked: true
Show Licence Plates → OFF                         showPlates: false, no plate on any row
restored                                          showPlates: true

PATCH /staff/:id {fullName}  "Technician Five" → "Technician Five Probe" → restored
GET  /auth/me                fullName returned whole

AuditLog: 4 × CONFIG_CHANGE (each rule flip, before/after, attributed)
          2 × STAFF_UPDATE   (rename and restore, before/after)
```

Only a waiting vehicle was on the board during the probe, so the **Quality
Check** label is covered by the stage mapping and the surface test, not by a
live QC car. Stated so it is not mistaken for a live observation.

**Navigation paths exercised (code-level, each entry point → form → back):**
queue ticket → inspection / job sheet → **Back to Job**; technician job → **Back
to My Job**; visit record → **Back to Visit Record**; Inspections list → **Back to
Inspections**; direct URL → the visit.

## D. Deployment instructions

**Code changes** — deploy through the existing GitHub → Render workflow. The
migration runs with `prisma migrate deploy`; it only inserts rule rows.

**Infrastructure / configuration — the person managing deployment must do
these; this is what resolves Issues 1 and 2:**

1. On the **bsop-web** service, confirm these are set, then **trigger a
   redeploy of the web service** (they are baked at build time — setting them
   without rebuilding changes nothing):
   ```
   NEXT_PUBLIC_API_URL = https://<bsop-api host>/api/v1
   NEXT_PUBLIC_WS_URL  = https://<bsop-api host>
   ```
   The build now fails loudly if the first is missing on Render.
2. On the **bsop-api** service, confirm:
   ```
   PUBLIC_APP_URL   = https://<bsop-web host>      (every customer link is built from this)
   API_CORS_ORIGIN  = https://<bsop-web host>      (exact origin; "*" is refused at boot)
   NODE_ENV=production   ALLOW_DEV_LOGIN=false
   ```
   Run `pnpm deploy:check` in the API service; it fails on any bad value.
3. **HTTPS is required for the tablet camera.** The live camera API is refused
   on plain `http://` addresses. Tablets must open the `https://` Render address
   (or a custom domain with a certificate), not a LAN IP.
4. Nothing to configure for Issues 4, 5, 6.

No credentials, connection strings or admin access appear in any public
configuration introduced by this work.

## E. Outstanding issues — disclosed, not assumed

| Item | Why it is outstanding | Who |
| --- | --- | --- |
| **External access to `/book` and `/status` (Issues 1–2)** | Requires the deployed environment. Cannot be verified from the development machine, and the directive forbids claiming it. Run `docs/123_Booking_UAT_Checklist.md` on a phone with Wi-Fi off after §D step 1. | Owner |
| **Tablet camera on real devices (Issue 3)** | No Android tablet or iPad available here. The live-camera, shutter, flip and orientation paths need §9.2 device testing. The fallback path is deterministic and will at minimum open the device's camera app or gallery. | Owner / workshop |
| **Status page shows a masked plate** | An earlier privacy decision masks it (`***` + last 4). The directive asks for the registration. One-line decision; trivial change either way. | Management |
| **Job sheet attachments (§4.4E)** | Not being done. The owner has ruled that the sheets and forms are finished and are not to change; the job sheet has no attachment model and will not be given one. Inspection photos already attach to the same visit. | Closed — owner decision |
| **Twelve initial-only staff names (Issue 6)** | "J. Walters" cannot become "Jason Walters" without someone who knows the name. Use Staff → Edit name. | Manager |
| **Scroll position / expanded panels on return (§5.4D "where practical")** | The job stays selected (it is the URL). Scroll restoration is browser-default; not engineered further. | — |

## F. Final acceptance checklist

| Requirement | Expected result | Status |
| --- | --- | --- |
| Customer booking link | Accessible outside Bert's network | **Pending §D step 1 + external UAT** |
| Customer-status link | Accessible outside Bert's network | **Pending §D step 1 + external UAT** |
| Tablet camera | Captures photographs directly where supported | Code-complete; **device test pending** |
| Tablet image uploads | Correctly saved and linked | Code-complete (same endpoint, same visit); **device test pending** |
| Job sheet navigation | Returns to originating job | **Done** |
| Vehicle inspection navigation | Returns to originating job | **Done** |
| Pre-inspection navigation | Returns to originating job | **Done** |
| Customer display | Shows licence plate and status | **Done — verified live** |
| Display updates | Automatic and accurate | **Done** (socket push + 10 s poll; close already recomputes) |
| Technician greeting | Shows correct readable employee name | **Done** (data correction is a manager task) |
| Desktop compatibility | Existing functionality preserved | **Done** — 411 + 1800 tests, builds clean |
| Production deployment | Verified or dependencies explicitly identified | **Dependencies identified in §D** |
