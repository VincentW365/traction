-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "loyalty_member" BOOLEAN NOT NULL DEFAULT false;

-- CR-2026-050: backfill loyalty membership from the legacy loyalty number
-- (any non-empty number → member). The loyalty_number column is retained but
-- no longer used by the app.
UPDATE "customers"
   SET "loyalty_member" = true
 WHERE "loyalty_number" IS NOT NULL AND btrim("loyalty_number") <> '';
