-- CR-2026-108 Stage 5C — the resource-aware engine, in SHADOW.
--
-- ADDITIVE ONLY. Two changes, neither of which any production path reads while
-- `booking_capacity_mode` stays FIXED.
--
-- 1. resource_reservations.required_capability
--    `resource_id` was already nullable, meaning "any compatible resource" — but
--    nothing recorded what it had to be compatible WITH, so an abstract
--    reservation could not be counted against a pool. A booking reserves "one
--    ALIGNMENT position", not ALIGN-01; dispatch picks the physical bay later.
--    This is the smallest field that makes those semantics expressible.
--
-- 2. booking_shadow_comparisons
--    Where the resource model would have disagreed with the fixed limit. Written
--    only on a MEANINGFUL DIFFERENCE — agreement is the expected case and storing
--    it would bury the signal. Deliberately free of PII: no customer, vehicle,
--    plate, appointment id or token. A disagreement is a fact about the shop's
--    capacity, not about a person.
--
--    `config_fingerprint` ties a finding to the inventory it was measured
--    against. Without it, a row from last week is uninterpretable the moment
--    somebody commissions a bay.
--
-- ROLLBACK: drop the table and the column. Nothing in the production booking path
-- reads either, and RESOURCE_AWARE cannot be activated without a separate,
-- preflight-guarded configuration change.

ALTER TABLE "resource_reservations"
  ADD COLUMN IF NOT EXISTS "required_capability" TEXT;

-- Overlap lookups for reservation-aware capacity checks.
CREATE INDEX IF NOT EXISTS "resource_reservations_overlap_idx"
  ON "resource_reservations" ("site_id", "status", "reserved_from", "reserved_until");

CREATE TABLE IF NOT EXISTS "booking_shadow_comparisons" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_id"                UUID NOT NULL,
  "observed_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evaluation_source"      TEXT NOT NULL,
  "service_codes"          TEXT[] NOT NULL,
  "required_capability"    TEXT,
  "slot_start_at"          TIMESTAMPTZ NOT NULL,
  "slot_end_at"            TIMESTAMPTZ NOT NULL,
  "planned_minutes"        INTEGER NOT NULL,
  "vehicle_class"          TEXT,
  "fixed_available"        BOOLEAN NOT NULL,
  "fixed_reason_code"      TEXT NOT NULL,
  "resource_available"     BOOLEAN NOT NULL,
  "resource_reason_code"   TEXT NOT NULL,
  "resource_status"        TEXT NOT NULL,
  "eligible_positions"     INTEGER NOT NULL,
  "remaining_positions"    INTEGER NOT NULL,
  "configuration_complete" BOOLEAN NOT NULL,
  "config_fingerprint"     TEXT NOT NULL,
  CONSTRAINT "booking_shadow_comparisons_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "booking_shadow_comparisons_site_id_observed_at_idx"
  ON "booking_shadow_comparisons" ("site_id", "observed_at");
CREATE INDEX IF NOT EXISTS "booking_shadow_comparisons_observed_at_idx"
  ON "booking_shadow_comparisons" ("observed_at");
CREATE INDEX IF NOT EXISTS "booking_shadow_comparisons_required_capability_observed_at_idx"
  ON "booking_shadow_comparisons" ("required_capability", "observed_at");

ALTER TABLE "booking_shadow_comparisons"
  ADD CONSTRAINT "booking_shadow_comparisons_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "sites" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
