# CR-2026-046 — Inspection digital sign-off: drawn signature for Senior Technician

**Status:** IMPLEMENTED. **Type:** Inspection sign-off enhancement — owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
"Inspection Form should have a digital sign-off option for Senior Technician and Customer. Set up a digital signature system for it."

## 2. Starting point (already built — CR-2026-034)
The inspection digital sign-off system already existed: the `InspectionSignature` model (roles `SENIOR_TECH` / `CUSTOMER`, types `TYPED` / `DRAWN`, `typedName`, base64 `imageData`), the `SignaturePad` canvas component, the COMPLETED → SIGNED_OFF → CLOSED flow, audit + status-history, and a print signature block. The **customer** sign-off was fully drawn-or-typed. The only gap: the **Senior Technician** sign-off was **typed-name only** (`signoff()` hardcoded `type: 'TYPED'`; the UI had just a name field). This CR brings the senior-tech flow to parity — a true drawn (or typed) signature.

**Owner decisions:** keep the existing sign-off authority (Managers/Admins sign as "Senior Technician" via `INSPECTION_SIGNOFF` — no new role, no RBAC change); customer signs staff-assisted on the shop device (no public/remote token page).

## 3. Change
### Backend
- **`dto/signoff-inspection.dto.ts`** — now mirrors `CustomerSignoffDto`: optional `type` (`InspectionSignatureType`, defaults to TYPED in the service for back-compat), optional `typedName`, optional `imageData` (`@MaxLength(2_000_000)`).
- **`inspections.service.ts` `signoff()`** — drawn-or-typed branch (same shape as `customerSignoff()`): `type = dto.type ?? 'TYPED'`; DRAWN requires `imageData`, TYPED requires `typedName`; writes the `SENIOR_TECH` signature with `type` + `typedName` (TYPED only) / `imageData` (DRAWN only). The conditional `updateMany` race guard, `signedOffByUserId/At`, status-history, and `INSPECTION_SIGNED_OFF` audit are unchanged.

### Frontend
- **`inspections/[id]/page.tsx`** — the senior-tech sign-off section now has a Drawn/Typed toggle: DRAWN renders `<SignaturePad>`, TYPED renders the name input; the mutation sends `{ type, typedName? | imageData? }`; the button is disabled until valid.
- **`inspections/[id]/print/page.tsx`** — the Senior Technician signature cell now renders the drawn `imageData` (with `typedName` fallback), matching the Customer cell. *(This was a real bug: the senior-tech cell previously rendered only `typedName`, so a drawn senior-tech signature would not have printed.)*

### Unchanged
Schema (model already supported it) → no migration; `permissions.ts`/roles; `SignaturePad`; the customer sign-off path.

## 4. Files
- `apps/api/src/modules/inspections/dto/signoff-inspection.dto.ts`
- `apps/api/src/modules/inspections/inspections.service.ts` (`signoff()`)
- `apps/api/src/modules/inspections/__tests__/inspections-signoff.service.spec.ts` (added DRAWN cases)
- `apps/web/app/(dashboard)/inspections/[id]/page.tsx`
- `apps/web/app/(dashboard)/inspections/[id]/print/page.tsx`
- `docs/68_CR_2026_046_Inspection_Signoff_Signature.md` (this file)

## 5. Verification
- API typecheck green; API `vitest run` green — **65 files / 511 tests** (inspections suite 29/29, incl. new senior-tech DRAWN valid + DRAWN-without-image rejection; existing typed/omitted-type cases still pass via the TYPED default).
- Web typecheck green; route-smoke green (66/66).

## 6. Governance
Additive, backward-compatible DTO field + a service branch reusing the existing customer pattern + a print render fix. No schema change, no RBAC/permission change, no new dependency, no lifecycle change → not a §9 review trigger. Reversible via git.
