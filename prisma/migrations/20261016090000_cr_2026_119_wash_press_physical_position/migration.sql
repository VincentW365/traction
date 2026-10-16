-- CR-2026-119 — the building, as the floor numbers it; the wash bay as a
-- capability of its own.
--
-- 1. physical_position: where a resource is, in the words the workshop uses
--    ("Position 3", "Wash area"). Free text, nullable, never derived from the
--    code. Additive; nothing existing changes.
--
-- 2. CLEAN-01 is remapped from GENERAL to CLEANING. Management confirmed a
--    dedicated wash area (2026-10-16), so a booked wash no longer competes for a
--    mechanical bay in the resource-aware model. Only rows still on GENERAL are
--    touched, so a catalogue already corrected by hand is left alone. The public
--    booking limit is FIXED and unaffected.
--
-- 3. PWASH-01 is named for what it is. Only while it still carries the seed name,
--    so a manager's rename is never overwritten.
--
-- Idempotent throughout.

ALTER TABLE "work_resources" ADD COLUMN IF NOT EXISTS "physical_position" TEXT;

UPDATE "service_types"
   SET "required_bay_type" = 'CLEANING'
 WHERE "code" = 'CLEAN-01'
   AND "required_bay_type" = 'GENERAL';

UPDATE "work_resources"
   SET "name" = 'Vehicle Wash Bay'
 WHERE "code" = 'PWASH-01'
   AND "name" = 'Power Wash';
