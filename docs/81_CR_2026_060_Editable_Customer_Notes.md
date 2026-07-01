# CR-2026-060 — Editable customer Notes (preserving the import tag)

**Status:** Implemented.
**Requested by:** Vincent Wilson — "Should be able to edit the notes section in the customer profile — make everything editable except the account details section."

## A. Objective
Make the customer **Notes** editable inline (like the other fields in CR-2026-055), completing
"everything editable except account details."

## B. Why it was excluded before, and how this makes it safe
CR-2026-055 left Notes read-only because `Customer.notes` also holds the import-rollback tag
(`import:<batchId>; raw="<NAME>"`), which the code says never to delete. **New insight:** the
rollback matches that tag as a **substring** (`notes contains "import:<batchId>"`, see
`scripts/import-customers.ts`), not the whole field. So we can keep the tag on the first line and
let staff notes follow — rollback still works, and notes become editable.

## C. Change
- **`customer-format.ts`**
  - `parseCustomerNotes` now treats the import tag as the **first line** and returns any following
    text as `staffNotes` (plus a new `importLine` for verbatim preservation). Pure-tag and
    plain-staff-note cases behave exactly as before.
  - New **`composeCustomerNotes(existingNotes, staffText)`** — the value to STORE on edit: preserves
    the existing import tag verbatim on line 1, appends the staff text; returns `null` when neither.
- **`customers.service.ts` `update()`** — when `notes` is provided, stores
  `composeCustomerNotes(existing.notes, data.notes)` instead of the raw text, so the import tag is
  never clobbered.
- **`customers/[id]/page.tsx`** — the Notes card gets an **Edit** button → textarea (prefilled with
  `staffNotes`) → Save via the existing `PATCH /customers/:id { notes }`.

## D. Impacted modules / data
- API: `customer-format.ts`, `customers.service.ts` (+ format spec). No schema change; DTO already
  accepted `notes`.
- Web: `customers/[id]/page.tsx`.
- The import tag is preserved in storage but never shown/edited in the UI (staff see only their notes).

## E. Risks / tradeoffs
- Assumes the import tag is a single first line (it is — `import-customers.ts` writes exactly
  `import:<id>; raw="<name>"`). Staff notes are stored on subsequent lines.
- Clearing notes on an imported customer keeps just the tag; on a non-imported customer stores `null`.

## F. Tests / validation
- `pnpm --filter @bsop/api exec tsc --noEmit` and `--filter @bsop/web` — green.
- `pnpm --filter @bsop/api exec vitest run src/modules/customers` — 45 passed (new parse + compose
  cases: tag preserved, staff notes appended, rollback-safe).

## G. Approval gate
No schema/RBAC change; reuses the existing write path; preserves the documented import invariant →
**not a §9 trigger**. Recorded as a Change Request; reversible via git.
