# CR-2026-055 — Fully editable customer details in the directory

**Status:** Implemented.
**Requested by:** Vincent Wilson — "have everything for the customer to be editable in the customers directory, like how the loyalty status can be edited."

## A. Objective
Bring the customer detail page to parity with the loyalty-status edit: make the customer's
identity, contact, and notification-consent fields editable inline, the same way `loyaltyMember`
already is.

## B. Inputs used
- `apps/web/app/(dashboard)/customers/[id]/page.tsx` — existing loyalty inline-edit pattern.
- `apps/api/.../customers/dto/update-customer.dto.ts`, `customers.service.ts` — PATCH already
  accepts `firstName, lastName, phone, email, notificationOptInSms, notificationOptInEmail, notes`.
- `customer-serializer.ts`, `customer-format.ts` — detail shape; phone split + notes/import parsing.

## C. Assumptions
1. The existing `PATCH /customers/:id` (permission `CUSTOMER_UPDATE`, sandbox-guarded) is the
   correct write path — no new endpoint needed.
2. Editing one card patches only that card's fields (partial update), matching loyalty.

## D. Design / change
**Editable (1:1, safe):**
- **Customer Identity** — first name, last name.
- **Contact Details** — phone, email.
- **Preferences & Consent** — SMS opt-in, email opt-in (Yes/No selects).
- Loyalty status — already editable (unchanged).

Each card gets an **Edit** button → inline inputs prefilled from the current record → Save/Cancel,
via the shared `PATCH /customers/:id`. Query invalidation refreshes the card on success.

**Backend:** the only change is exposing the **raw** phone on the detail response
(`phoneRaw`) so the edit form prefills/patches the stored value accurately (the displayed `phones[]`
is a formatted split of that raw string). DTO + service already handle every edited field.

## E. Deliberately NOT editable
- **Notes** — left view-only **on purpose**. `Customer.notes` doubles as the import-rollback key
  (`import:<batchId>; raw="<NAME>"`, which the code says to *never delete*). A naive notes edit would
  clobber that invariant. Making notes safely editable needs a separate field/design and is out of
  scope for this CR.
- **Customer #, Created, customer since** — immutable/system-managed.

## F. Impacted modules / data
- API: `customers/customer-serializer.ts` (+`phoneRaw` on detail). No DTO/service/schema change.
- Web: `customers/[id]/page.tsx` — three cards made editable + a shared update mutation per card.

## G. Risks / tradeoffs
- Phone is stored as a single string (historical multi-number concat); the field accepts free text
  and the display re-splits on render. Empty phone is blocked in the UI (Save disabled).
- Clearing email sends `null` (accepted by `@IsOptional() @IsEmail()`).

## H. Tests / validation
- `pnpm --filter @bsop/web exec tsc --noEmit` — green.
- `pnpm --filter @bsop/api exec tsc --noEmit` — green.
- `pnpm --filter @bsop/api exec vitest run src/modules/customers` — 40 passed (serializer asserts
  per-field, unaffected by the additive `phoneRaw`).

## Approval gate
No schema change, no new dependency, no RBAC change, reuses the existing write path → **not a §9
trigger**. Recorded as a Change Request for traceability. Reversible via git.
