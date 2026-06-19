# CR-2026-051 — Check-in: free-text "Other" for oil brand & grade

**Status:** IMPLEMENTED. **Type:** Check-in UX tweak — owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-19

## 1. Request
"When checking in, if **Other** is chosen for Oil Brand, allow typing the oil type — **optional**, only shown when Other is selected. Also add an **Other** option to Oil Grade and do the same."

## 2. Change
Both check-in intake surfaces — the dedicated **Check-In page** (appointment check-in + walk-in registration) and the **Appointment detail modal** check-in:
- **Oil Brand** already had an "Other" option. When "Other" is selected, an **optional** free-text input appears to type the brand. It is never required.
- **Oil Grade** now has an "Other" option too, with the same optional free-text input shown only when "Other" is selected.
- On submit, the typed value is sent as `oilBrand` / `oilGrade` when "Other" + text is provided; if "Other" is selected with no text, the literal "Other" is sent (still optional — the whole field can be left blank). Selecting a preset sends the preset as before.
- The "Other" text inputs reset with the rest of the form.

No new fields: `oilBrand` / `oilGrade` were already free-string columns. Added a defensive `@MaxLength(100)` on those DTO fields (`check-in.dto.ts`, `create-walk-in.dto.ts`) now that they accept arbitrary text.

## 3. Files
- `apps/web/app/(dashboard)/check-in/page.tsx` — Other text inputs + grade "Other" option + submit/reset wiring.
- `apps/web/components/appointment-detail-modal.tsx` — same for the modal check-in; `OIL_GRADES` gains "Other".
- `apps/api/src/modules/appointments/dto/check-in.dto.ts` — `@MaxLength(100)` on oilBrand/oilGrade.
- `apps/api/src/modules/walk-ins/dto/create-walk-in.dto.ts` — `@MaxLength(100)` on oilBrand/oilGrade.
- `docs/73_CR_2026_051_CheckIn_Oil_Other.md` (this file).

## 4. Verification
- API + web typecheck green; appointments/walk-ins vitest green (29); web route-smoke 66/66.

## 5. Governance
Presentational + additive validation only. No schema change, no rule/auth change. Not a §9 trigger.
