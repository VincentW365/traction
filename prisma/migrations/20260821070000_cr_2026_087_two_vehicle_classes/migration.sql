-- CR-2026-087 — reduce VehicleServiceClass to Sedan + SUV (+ the review state).
--
-- The shop only distinguishes sedans from SUVs, and the per-category service
-- times are defined for exactly those two. SUV_LIGHT, SUV_HEAVY, PICKUP, VAN and
-- TRUCK are folded into a single SUV_CLASS.
--
-- Postgres cannot drop a value from an enum in place, so this rebuilds the type:
-- create the new type, rewrite each dependent column through text with the value
-- mapping applied, then drop the old type and take its name.
--
-- Four dependent columns across three tables:
--   vehicles.service_class
--   vehicle_classifications.suggested_service_class
--   vehicle_classifications.confirmed_service_class
--   vehicle_weight_suggestions.suggested_service_class
--
-- NULL is preserved throughout (all four columns are nullable, and "no class yet"
-- is distinct from "reviewed and unknown"). UNKNOWN_REQUIRES_REVIEW is kept so an
-- unreviewed vehicle stays visibly unreviewed rather than being guessed into SUV.
--
-- DMAIC Rule 3 is unaffected: the mobile-jack gate tests `= 'SEDAN_CLASS'`, and
-- every folded value was already non-sedan, i.e. already blocked.
--
-- Not reversible without a backup: the pickup/van/truck distinction is discarded.

-- 1. The new type, under a temporary name.
CREATE TYPE "VehicleServiceClass_new" AS ENUM (
  'SEDAN_CLASS',
  'SUV_CLASS',
  'UNKNOWN_REQUIRES_REVIEW'
);

-- 2. Rewrite each column: enum -> text -> mapped -> new enum.
--    USING runs per row, so the CASE does the backfill as part of the type change
--    and there is no window where a row holds a value the type does not allow.
ALTER TABLE "vehicles"
  ALTER COLUMN "service_class" TYPE "VehicleServiceClass_new"
  USING (
    CASE "service_class"::text
      WHEN 'SEDAN_CLASS'             THEN 'SEDAN_CLASS'
      WHEN 'UNKNOWN_REQUIRES_REVIEW' THEN 'UNKNOWN_REQUIRES_REVIEW'
      WHEN 'SUV_LIGHT'               THEN 'SUV_CLASS'
      WHEN 'SUV_HEAVY'               THEN 'SUV_CLASS'
      WHEN 'PICKUP'                  THEN 'SUV_CLASS'
      WHEN 'VAN'                     THEN 'SUV_CLASS'
      WHEN 'TRUCK'                   THEN 'SUV_CLASS'
      ELSE NULL
    END
  )::"VehicleServiceClass_new";

ALTER TABLE "vehicle_classifications"
  ALTER COLUMN "suggested_service_class" TYPE "VehicleServiceClass_new"
  USING (
    CASE "suggested_service_class"::text
      WHEN 'SEDAN_CLASS'             THEN 'SEDAN_CLASS'
      WHEN 'UNKNOWN_REQUIRES_REVIEW' THEN 'UNKNOWN_REQUIRES_REVIEW'
      WHEN 'SUV_LIGHT'               THEN 'SUV_CLASS'
      WHEN 'SUV_HEAVY'               THEN 'SUV_CLASS'
      WHEN 'PICKUP'                  THEN 'SUV_CLASS'
      WHEN 'VAN'                     THEN 'SUV_CLASS'
      WHEN 'TRUCK'                   THEN 'SUV_CLASS'
      ELSE NULL
    END
  )::"VehicleServiceClass_new";

ALTER TABLE "vehicle_classifications"
  ALTER COLUMN "confirmed_service_class" TYPE "VehicleServiceClass_new"
  USING (
    CASE "confirmed_service_class"::text
      WHEN 'SEDAN_CLASS'             THEN 'SEDAN_CLASS'
      WHEN 'UNKNOWN_REQUIRES_REVIEW' THEN 'UNKNOWN_REQUIRES_REVIEW'
      WHEN 'SUV_LIGHT'               THEN 'SUV_CLASS'
      WHEN 'SUV_HEAVY'               THEN 'SUV_CLASS'
      WHEN 'PICKUP'                  THEN 'SUV_CLASS'
      WHEN 'VAN'                     THEN 'SUV_CLASS'
      WHEN 'TRUCK'                   THEN 'SUV_CLASS'
      ELSE NULL
    END
  )::"VehicleServiceClass_new";

ALTER TABLE "vehicle_weight_suggestions"
  ALTER COLUMN "suggested_service_class" TYPE "VehicleServiceClass_new"
  USING (
    CASE "suggested_service_class"::text
      WHEN 'SEDAN_CLASS'             THEN 'SEDAN_CLASS'
      WHEN 'UNKNOWN_REQUIRES_REVIEW' THEN 'UNKNOWN_REQUIRES_REVIEW'
      WHEN 'SUV_LIGHT'               THEN 'SUV_CLASS'
      WHEN 'SUV_HEAVY'               THEN 'SUV_CLASS'
      WHEN 'PICKUP'                  THEN 'SUV_CLASS'
      WHEN 'VAN'                     THEN 'SUV_CLASS'
      WHEN 'TRUCK'                   THEN 'SUV_CLASS'
      ELSE NULL
    END
  )::"VehicleServiceClass_new";

-- 3. Swap the types over.
DROP TYPE "VehicleServiceClass";
ALTER TYPE "VehicleServiceClass_new" RENAME TO "VehicleServiceClass";
