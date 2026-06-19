# CR-2026-050 — Loyalty is a Yes/No flag (not a number)

**Status:** IMPLEMENTED. **Type:** Customer schema + UX change — owner-directed. §9 review trigger; this doc is the artifact.
**Author:** Vincent Wilson · **Date:** 2026-06-19

## 1. Request
"Loyalty members do not have a number — they are either Loyalty Customers or not. The option should be **Yes / No** instead of inputting a number."

## 2. Approach (additive, non-destructive)
The app already treated loyalty as a boolean everywhere (`hasLoyalty` badges, the directory filter); only the **input + storage** were a string number. So:
- **Added** `Customer.loyaltyMember Boolean @default(false)` — the new source of truth.
- **Backfilled** it from the legacy number: `loyalty_member = true` where `loyalty_number` is non-empty (3,810 of 6,884 customers).
- **Retained** the legacy `loyalty_number` column (deprecated, no longer read/written by the app) so no historical data is lost — it can be dropped in a later cleanup if desired.
- The UI now offers a **Yes / No** control; the loyalty number is no longer shown or entered anywhere.

## 3. Changes
### Schema / migration
- `prisma/schema.prisma` — `Customer.loyaltyMember` added; `loyaltyNumber` annotated deprecated.
- `prisma/migrations/20260619070448_customer_loyalty_member/` — `ADD COLUMN loyalty_member` + backfill `UPDATE` from `loyalty_number` presence.

### API
- `dto/create-customer.dto.ts`, `dto/update-customer.dto.ts` — `loyaltyNumber?: string` → `loyaltyMember?: boolean` (`@IsBoolean`).
- `customers.service.ts` — create/update set `loyaltyMember`; directory SQL `has_loyalty` and the `hasLoyalty` filter now read `loyalty_member`.
- `customer-serializer.ts` — `hasLoyalty` derives from `loyaltyMember`; `loyaltyNumber` removed from `CustomerCore`, the list item, and the detail (it is no longer exposed by the API, including the ADMIN/Manager import-meta view).
- `scripts/import-customers.ts` — also sets `loyaltyMember` from number presence (keeps writing the legacy column).

### Web
- `customers/page.tsx` — new-customer form: Loyalty Number text input → **Loyalty Member: No/Yes** select; sends `loyaltyMember`.
- `customers/[id]/page.tsx` — Loyalty Status edit: text input → **No/Yes** select sending `loyaltyMember`; the "Loyalty Number" display is removed (the ★ Member / Not-a-member badge remains).

## 4. Files
- `prisma/schema.prisma`, `prisma/migrations/20260619070448_customer_loyalty_member/migration.sql`
- `apps/api/src/modules/customers/{customer-serializer.ts, customers.service.ts}`
- `apps/api/src/modules/customers/dto/{create,update}-customer.dto.ts`
- `apps/api/src/modules/customers/__tests__/{customers.service.spec.ts, customer-serializer.spec.ts}`
- `apps/api/scripts/import-customers.ts`
- `apps/web/app/(dashboard)/customers/page.tsx`, `apps/web/app/(dashboard)/customers/[id]/page.tsx`
- `docs/72_CR_2026_050_Loyalty_Member_Boolean.md`

## 5. Verification
- DB: migration applied; backfill set `loyalty_member = true` for 3,810 customers (= count with a legacy number).
- API typecheck green; API `vitest run` green — **65 files / 513 tests** (customers suite 40/40, updated loyalty create/update/serializer tests).
- Web typecheck green; route-smoke green (66/66).
- A full `pg_dump` backup was taken before the migration (`backups/…pre_loyalty_member…sql`, gitignored).

## 6. Governance
Additive schema change to a core entity (`Customer`) → §9 trigger; owner-directed. Non-destructive (new nullable-default column + derived backfill; legacy column retained), reversible (drop the column / restore from backup). No auth, rule, or other contract change.
