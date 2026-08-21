-- CR-2026-092 — service contribution policy.
--
-- Replaces the binary "identifies a manager package, or makes the job custom" model.
-- Most real work is neither, and forcing it into one of those two is what left
-- ordinary jobs without a benchmark: a fuel filter is genuine extra technician time,
-- a tyre-pressure check is already inside the General Service allowance, and preparing
-- a quotation is not technician repair time at all.
--
-- Additive throughout. Existing mappings are converted in place so nothing loses its
-- configuration, and existing snapshots keep every rating and standard they already
-- carry — only the new descriptive columns are filled in.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "KpiContributionMode" AS ENUM (
  'PACKAGE_COMPONENT',
  'INCLUDED_IN_BASE',
  'ADDITIVE_STANDARD',
  'SEPARATE_SLA',
  'CONDITIONAL',
  'CUSTOM_ONLY'
);

CREATE TYPE "KpiDurationSource" AS ENUM (
  'MANAGER_PACKAGE',
  'SERVICE_CATALOG_DURATION',
  'FIXED_CONFIGURED_DURATION',
  'NO_DURATION'
);

CREATE TYPE "KpiAllowanceBasis" AS ENUM ('PER_JOB', 'PER_SERVICE_LINE', 'PER_UNIT');

CREATE TYPE "KpiRequiredQualifier" AS ENUM ('NONE', 'BRAKE', 'TIRE_OPERATION');

CREATE TYPE "BrakeAxle" AS ENUM ('FRONT', 'REAR');

CREATE TYPE "BrakeWorkType" AS ENUM (
  'PADS', 'SHOES', 'ROTOR_OR_DISC', 'FLUID_OR_BLEED', 'INSPECTION_ONLY', 'OTHER'
);

CREATE TYPE "TireOperation" AS ENUM (
  'PRESSURE_OR_TREAD_CHECK', 'ROTATION', 'BALANCE', 'ALIGNMENT',
  'PUNCTURE_REPAIR', 'REPLACEMENT', 'OTHER_PHYSICAL_WORK'
);

CREATE TYPE "KpiBenchmarkSource" AS ENUM (
  'MANAGER_PACKAGE',
  'MANAGER_PACKAGE_PLUS_ADDITIVES',
  'CATALOG_COMPOSITE',
  'MANAGER_CUSTOM',
  'NOT_TECHNICIAN_RATED'
);

-- ---------------------------------------------------------------------------
-- Contribution policy on the existing mapping table
--
-- Adapted rather than replaced: a parallel table would leave two places claiming to
-- say what a service means, and the effective-dating and audit trail already live
-- here.
-- ---------------------------------------------------------------------------
ALTER TABLE "kpi_service_components"
  ADD COLUMN "contribution_mode"     "KpiContributionMode" NOT NULL DEFAULT 'CUSTOM_ONLY',
  ADD COLUMN "duration_source"       "KpiDurationSource"   NOT NULL DEFAULT 'NO_DURATION',
  ADD COLUMN "fixed_sedan_minutes"   INTEGER,
  ADD COLUMN "fixed_suv_minutes"     INTEGER,
  ADD COLUMN "allowance_basis"       "KpiAllowanceBasis"   NOT NULL DEFAULT 'PER_JOB',
  ADD COLUMN "required_qualifier"    "KpiRequiredQualifier" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "provisional_duration"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_superseded_code"    BOOLEAN NOT NULL DEFAULT false;

-- Convert what is already configured, so no existing mapping silently becomes
-- CUSTOM_ONLY and drops its job out of a benchmark it was earning yesterday.
UPDATE "kpi_service_components"
SET "contribution_mode" = 'PACKAGE_COMPONENT',
    "duration_source"   = 'MANAGER_PACKAGE'
WHERE "component_role" IN ('GENERAL_SERVICE_CORE', 'SPARK_PLUGS');

-- Brake components become conditional: "brake work" is front pads or rear shoes or a
-- fluid bleed, and those are different jobs with different allowances.
UPDATE "kpi_service_components"
SET "contribution_mode"  = 'CONDITIONAL',
    "duration_source"    = 'SERVICE_CATALOG_DURATION',
    "required_qualifier" = 'BRAKE'
WHERE "component_role" = 'FRONT_BRAKES';

UPDATE "kpi_service_components"
SET "contribution_mode" = 'INCLUDED_IN_BASE',
    "duration_source"   = 'NO_DURATION'
WHERE "component_role" = 'INCLUDED_NO_ADDITIONAL_BENCHMARK';

-- Work previously marked as forcing a custom benchmark is mostly ordinary additional
-- work, but reclassifying it wholesale would be a guess. It becomes ADDITIVE_STANDARD
-- on its catalogue time, which is the honest reading of "substantial extra work" and
-- is what the manager can now see and adjust on the admin screen.
UPDATE "kpi_service_components"
SET "contribution_mode" = 'ADDITIVE_STANDARD',
    "duration_source"   = 'SERVICE_CATALOG_DURATION'
WHERE "component_role" = 'FORCES_CUSTOM_BENCHMARK';

CREATE INDEX "kpi_service_components_contribution_mode_idx"
  ON "kpi_service_components"("contribution_mode", "is_active");

-- ---------------------------------------------------------------------------
-- Structured qualifiers on the work-order line
-- ---------------------------------------------------------------------------
ALTER TABLE "service_order_items"
  ADD COLUMN "brake_work_type" "BrakeWorkType",
  ADD COLUMN "tire_operation"  "TireOperation",
  ADD COLUMN "unit_quantity"   INTEGER;

-- ---------------------------------------------------------------------------
-- Benchmark source and the arithmetic behind the standard
-- ---------------------------------------------------------------------------
ALTER TABLE "work_order_kpi_snapshots"
  ADD COLUMN "benchmark_source"      "KpiBenchmarkSource" NOT NULL DEFAULT 'NOT_TECHNICIAN_RATED',
  ADD COLUMN "calculation_breakdown" JSONB,
  ADD COLUMN "calculation_revisions" JSONB;

-- Describe what historical snapshots already were. This changes no rating, no
-- standard and no eligibility — it only labels a figure that previously had no label.
UPDATE "work_order_kpi_snapshots"
SET "benchmark_source" = CASE
  WHEN "custom_standard_minutes" IS NOT NULL THEN 'MANAGER_CUSTOM'
  WHEN "standard_minutes" IS NOT NULL AND "package_type" <> 'CUSTOM_UNBENCHMARKED'
    THEN 'MANAGER_PACKAGE'
  ELSE 'NOT_TECHNICIAN_RATED'
END::"KpiBenchmarkSource";

CREATE INDEX "work_order_kpi_snapshots_benchmark_source_idx"
  ON "work_order_kpi_snapshots"("benchmark_source");
