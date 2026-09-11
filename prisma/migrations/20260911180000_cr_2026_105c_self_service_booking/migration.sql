-- CR-2026-105c — customer self-service booking (docs/120 §D2, §E).
--
-- Additive only. No backfill: staff-created and historical appointments keep
-- NULL reference/token columns.
--
--   appointments.appointment_number     human-readable BK-{LOC}-{YYMMDD}-{SEQ}
--   appointments.manage_token_hash      sha256 of the customer's manage-link token
--                                       (the raw token is never stored)
--   appointments.manage_token_expires_at
--   daily_booking_counters              per-site, per-business-day sequence for the
--                                       reference, allocated with one atomic upsert
--                                       (same pattern as daily_ticket_counters)

ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "appointment_number" TEXT,
  ADD COLUMN IF NOT EXISTS "manage_token_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "manage_token_expires_at" TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS "appointments_appointment_number_key" ON "appointments"("appointment_number");
CREATE UNIQUE INDEX IF NOT EXISTS "appointments_manage_token_hash_key" ON "appointments"("manage_token_hash");

CREATE TABLE IF NOT EXISTS "daily_booking_counters" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_id" UUID NOT NULL,
  "business_date" DATE NOT NULL,
  "last_sequence" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "daily_booking_counters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_booking_counters_site_id_business_date_key"
  ON "daily_booking_counters"("site_id", "business_date");

DO $$ BEGIN
  ALTER TABLE "daily_booking_counters"
    ADD CONSTRAINT "daily_booking_counters_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
