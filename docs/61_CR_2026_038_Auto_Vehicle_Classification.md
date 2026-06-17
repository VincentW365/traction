# CR-2026-038 — Automatic vehicle classification (retire the manual section)

**Status:** IMPLEMENTED. **Type:** Rule-3-adjacent behavior + UI removal — §9 item, owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-15

## 1. Request
"For vehicle classification, can this be done automatically instead of having a whole complete section?" The make/model suggestion engine already existed but was advisory only (staff had to confirm every vehicle in a review queue + a progress report).

## 2. Change — auto-apply confident suggestions
`ClassificationService.autoClassify(vehicleId, actor?)` (new):
- Runs the existing `suggestVehicleClass` (make/model/year → class + confidence).
- **HIGH or MEDIUM** confidence (make+model matched) → **writes** `serviceClass` (+ `weightClass`) automatically, with an audit entry (`CLASSIFICATION_AUTO_APPLIED`, source `MAKE_MODEL_LOOKUP`). No manual review.
- **LOW / NONE** → left **unclassified** (`serviceClass` stays null) so it appears in the small needs-review list and stays **mobile-jack blocked** (DMAIC Rule 3 fail-safe, unchanged).
- No-op if the vehicle already has a real class, or is a historical placeholder.

Hooked into **`VehiclesService.create`** so every new vehicle is auto-classified. (Existing fleet is already classified; this governs new vehicles. Check-in keeps using the vehicle's class; unknowns stay fail-safe blocked.)

## 3. UI — section trimmed to a small fallback
- The **"Vehicle Classification"** page is relabeled **"Unclassified Vehicles"** — it now shows only the few the auto-classifier couldn't match (the existing null-serviceClass queue), and still lets staff set/override the class per vehicle (and bulk).
- The **"Classification Progress"** report (burn-down) is **removed** (page + sidebar entry) — pointless once classification is automatic.

## 4. Safety
- Only **HIGH/MEDIUM** (make+model matched) are auto-applied — a make-only (LOW) guess is **not** auto-applied, protecting the mobile-jack (Rule 3) gate from a wrong positive.
- Never overwrites a staff/real class; placeholders skipped; unknowns remain blocked. The Rule 3 checker is untouched.

## 5. Files
- `apps/api/src/modules/vehicles/classification.service.ts` — `autoClassify`.
- `apps/api/src/modules/vehicles/vehicles.service.ts` — auto-classify on create (inject ClassificationService).
- `apps/api/src/modules/vehicles/__tests__/auto-classify.service.spec.ts` *(new)*; `vehicles.scope.spec.ts` + `vehicle-fields.spec.ts` updated for the 2-arg constructor.
- `apps/web/.../vehicle-classification/page.tsx` — relabeled to "Unclassified Vehicles".
- `apps/web/components/sidebar.tsx` — relabel + remove the Classification Progress entry.
- `apps/web/.../reports/classification/page.tsx` — **removed**.
- `docs/61_CR_2026_038_Auto_Vehicle_Classification.md` *(this file)*.

## 6. Notes / follow-ups
- The classification suggestion/confidence/confirm endpoints + stats/productivity remain (the page still uses confirm; stats/productivity now unused by UI — left in place, harmless).
- Optional one-time **bulk auto-apply** to clear any currently-unclassified vehicles can be run from the page (Confirm selected) or a small script; not required since the fleet is already classified.
- Coverage of auto-classification depends on the `VehicleWeightSuggestion` make/model rules; add rules to raise the HIGH/MEDIUM hit rate and shrink the needs-review list further.

## 7. Verification
API vitest green (new autoClassify spec + updated vehicle specs); API + web typecheck green; web route-smoke green.
