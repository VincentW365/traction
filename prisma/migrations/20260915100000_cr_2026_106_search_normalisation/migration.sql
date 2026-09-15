-- CR-2026-106 — search normalisation (docs/121 §C1).
--
-- 1. Data: Customer.phone is stored digits-only (imports already were; the few
--    UI-created rows carried dashes) and Vehicle.plate_number is stored stripped +
--    upper-cased (imports already were). A deliberate placeholder such as 'N/A'
--    (no digits at all) is left untouched. Idempotent: re-running changes nothing.
-- 2. Indexes: btree on the customer columns every search orders/filters by. No
--    extension is required (pg_trgm stays a follow-up if volume ever warrants it).

UPDATE customers
SET phone = regexp_replace(phone, '[^0-9]', '', 'g')
WHERE phone ~ '[^0-9]'
  AND regexp_replace(phone, '[^0-9]', '', 'g') <> '';

UPDATE vehicles
SET plate_number = upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g'))
WHERE plate_number ~ '[^A-Z0-9]'
  AND upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g')) <> '';

CREATE INDEX IF NOT EXISTS "customers_last_name_idx" ON "customers"("last_name");
CREATE INDEX IF NOT EXISTS "customers_first_name_idx" ON "customers"("first_name");
CREATE INDEX IF NOT EXISTS "customers_phone_idx" ON "customers"("phone");
CREATE INDEX IF NOT EXISTS "customers_email_idx" ON "customers"("email");
