-- CR-2026-095 — resources become fully application-managed.
--
-- Fully additive. Every existing resource keeps its id, code and relationships;
-- the new columns default to the behaviour the scheduler already assumed (supports
-- both classes, schedulable, capacity one, not retired, AVAILABLE).

CREATE TYPE "ResourceOperationalState" AS ENUM (
  'AVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'MAINTENANCE', 'OUT_OF_SERVICE'
);

ALTER TABLE "work_resources"
  ADD COLUMN "supports_sedan"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "supports_suv"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "scheduling_enabled"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "capacity"            INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "retired_at"          TIMESTAMPTZ,
  ADD COLUMN "retired_by_user_id"  UUID,
  ADD COLUMN "retire_reason"       TEXT;

-- A retired resource must not look active to any reader that predates retirement.
-- Nothing is retired yet, so this is a pure constraint for the future... enforced in
-- the service layer rather than a CHECK, because reactivation legitimately clears it.

ALTER TABLE "resource_operational_status"
  ADD COLUMN "status"             "ResourceOperationalState" NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN "expected_return_at" TIMESTAMPTZ,
  ADD COLUMN "status_since"       TIMESTAMPTZ;

-- Rows that already say "down" (the CR-2026-065 boolean toggle) become
-- TEMPORARILY_UNAVAILABLE — the most conservative reading of a bare "not
-- operational": it claims nothing about why and expects the resource back.
UPDATE "resource_operational_status"
SET "status" = 'TEMPORARILY_UNAVAILABLE', "status_since" = "updated_at"
WHERE "is_operational" = false;

-- Existing mobile jacks are sedan-only equipment by the standing DMAIC rule; stamp
-- the structured compatibility to match so the new field starts truthful rather
-- than defaulting every jack to "supports SUV".
UPDATE "work_resources"
SET "supports_suv" = false
WHERE "lift_type" IN ('mobile', 'power_jack');
