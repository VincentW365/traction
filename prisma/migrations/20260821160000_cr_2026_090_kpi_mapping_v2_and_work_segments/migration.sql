-- CR-2026-090 — KPI mapping v2 (component roles, service aliases, axle qualifier)
-- and per-technician work segments.
--
-- Two things this migration does NOT do, deliberately:
--
--  * It does not drop and re-add `kpi_service_components.component`. The generated
--    diff would have added the replacement column NOT NULL and lost the seeded
--    mappings. The old values are converted in place instead.
--  * It does not delete anything historical. Mappings are now effective-dated and
--    superseded rather than removed, because completed KPI snapshots were produced
--    under them and must stay reproducible.
--
-- The axle qualifier exists because the shop's real price list distinguishes axles
-- explicitly — separate lines for "To R/R DISC PADS" and "To R/R DISC PADS rear
-- electronic", plus brake shoes (drums, typically rear) — while Traction's own
-- service codes carry no axle at all. A brake line is therefore ambiguous on its
-- own, and rear-only work must never silently satisfy the Front Brakes benchmark.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "AxlePosition" AS ENUM ('FRONT', 'REAR', 'FRONT_AND_REAR', 'NOT_APPLICABLE');

CREATE TYPE "KpiComponentRole" AS ENUM (
  'GENERAL_SERVICE_CORE',
  'FRONT_BRAKES',
  'SPARK_PLUGS',
  'INCLUDED_NO_ADDITIONAL_BENCHMARK',
  'FORCES_CUSTOM_BENCHMARK'
);

CREATE TYPE "TechnicianSegmentRole" AS ENUM ('PRIMARY', 'ASSISTING', 'REPLACEMENT');

CREATE TYPE "SegmentStartSource" AS ENUM (
  'TECHNICIAN_START', 'TECHNICIAN_RESUME', 'ASSISTANCE_START',
  'REASSIGNMENT', 'MANAGER_CORRECTION'
);

CREATE TYPE "SegmentEndReason" AS ENUM (
  'PAUSED', 'REASSIGNED', 'ASSISTANCE_COMPLETE', 'SUBMITTED_TO_QC',
  'JOB_CANCELLED', 'SYSTEM_CLOSED', 'CORRECTED_BY_MANAGER'
);

-- ---------------------------------------------------------------------------
-- kpi_service_components: roles, aliases, qualifier, effective dating
-- ---------------------------------------------------------------------------

-- Aliases are the point: several codes may mean the same component, and a service
-- accumulates mapping history. One active mapping per service is enforced in the
-- service layer, not by a blanket unique index that would forbid both.
DROP INDEX "kpi_service_components_service_type_id_key";

ALTER TABLE "kpi_service_components"
  ADD COLUMN "component_role"          "KpiComponentRole",
  ADD COLUMN "requires_axle_qualifier" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_active"               BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "effective_from"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "effective_to"            TIMESTAMPTZ,
  ADD COLUMN "notes"                   TEXT,
  ADD COLUMN "updated_by_user_id"      UUID;

-- Convert the three old values into the new role vocabulary, preserving the seeded
-- mappings rather than discarding them.
UPDATE "kpi_service_components"
SET "component_role" = CASE "component"::text
  WHEN 'GENERAL_SERVICE' THEN 'GENERAL_SERVICE_CORE'
  WHEN 'FRONT_BRAKES'    THEN 'FRONT_BRAKES'
  WHEN 'SPARK_PLUGS'     THEN 'SPARK_PLUGS'
END::"KpiComponentRole";

ALTER TABLE "kpi_service_components" ALTER COLUMN "component_role" SET NOT NULL;
ALTER TABLE "kpi_service_components" DROP COLUMN "component";

-- Brake mappings are ambiguous without an axle, so any existing FRONT_BRAKES
-- mapping starts life requiring the qualifier.
UPDATE "kpi_service_components"
SET "requires_axle_qualifier" = true
WHERE "component_role" = 'FRONT_BRAKES';

CREATE INDEX "kpi_service_components_service_type_id_is_active_idx"
  ON "kpi_service_components"("service_type_id", "is_active");
CREATE INDEX "kpi_service_components_component_role_is_active_idx"
  ON "kpi_service_components"("component_role", "is_active");

-- The old enum is now unreferenced.
DROP TYPE "KpiPackageComponent";

-- ---------------------------------------------------------------------------
-- Axle qualifier on the work-order line
-- ---------------------------------------------------------------------------
ALTER TABLE "service_order_items" ADD COLUMN "axle_position" "AxlePosition";

-- ---------------------------------------------------------------------------
-- Technician work segments
--
-- Technician labour and job elapsed time are different quantities, and the pause
-- ledger cannot separate them: pauses are recorded per ORDER, so when two
-- technicians overlap there is no way to say who was working when. This records it
-- directly instead of inferring it.
-- ---------------------------------------------------------------------------
CREATE TABLE "technician_work_segments" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "service_order_id"     UUID NOT NULL,
  "assignment_id"        UUID NOT NULL,
  "technician_id"        UUID NOT NULL,
  "role_snapshot"        "TechnicianSegmentRole" NOT NULL DEFAULT 'PRIMARY',
  "started_at"           TIMESTAMPTZ NOT NULL,
  "ended_at"             TIMESTAMPTZ,
  "started_by_user_id"   UUID,
  "ended_by_user_id"     UUID,
  "start_source"         "SegmentStartSource" NOT NULL DEFAULT 'TECHNICIAN_START',
  "end_reason"           "SegmentEndReason",
  "notes"                TEXT,
  "corrected_by_user_id" UUID,
  "corrected_at"         TIMESTAMPTZ,
  "correction_reason"    TEXT,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ NOT NULL,

  CONSTRAINT "technician_work_segments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "technician_work_segments_service_order_id_idx"
  ON "technician_work_segments"("service_order_id");
CREATE INDEX "technician_work_segments_technician_id_idx"
  ON "technician_work_segments"("technician_id");
CREATE INDEX "technician_work_segments_assignment_id_idx"
  ON "technician_work_segments"("assignment_id");

-- A segment cannot end before it starts. Enforced in the database rather than only
-- in the service, because a negative labour figure is the kind of thing that gets
-- believed by a report long after the code that wrote it was changed.
ALTER TABLE "technician_work_segments"
  ADD CONSTRAINT "technician_work_segments_end_after_start"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- At most ONE open segment per technician per order. This is what stops a retried
-- Start request from creating a duplicate open segment, and it does so at the level
-- a retry cannot get around.
CREATE UNIQUE INDEX "technician_work_segments_one_open_per_tech_order"
  ON "technician_work_segments"("service_order_id", "technician_id")
  WHERE "ended_at" IS NULL;

ALTER TABLE "technician_work_segments"
  ADD CONSTRAINT "technician_work_segments_service_order_id_fkey"
  FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "technician_work_segments"
  ADD CONSTRAINT "technician_work_segments_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "technician_assignments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
