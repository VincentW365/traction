-- CR-2026-088 — Technician KPI framework.
--
-- Fully additive: six new enums and five new tables. Nothing existing is altered,
-- rewritten or dropped, so this is safe on a live database and reversible by
-- dropping the new objects.
--
-- Deliberately separate from the service-duration model: ServiceType durations
-- continue to drive booking, scheduling and customer ETAs and are untouched. A KPI
-- standard is a whole-job benchmark agreed by the manager, not a sum of catalogue
-- times — summing the catalogue would invent a number nobody approved and then
-- rate a technician against it.
--
-- The scheduling engine, queue priority, ETA calculation and appointment duration
-- arithmetic are untouched by this migration.

-- CreateEnum
CREATE TYPE "KpiPackageType" AS ENUM ('GENERAL_SERVICE_ONLY', 'GENERAL_SERVICE_FRONT_BRAKES', 'GENERAL_SERVICE_FRONT_BRAKES_SPARK_PLUGS', 'CUSTOM_UNBENCHMARKED');

-- CreateEnum
CREATE TYPE "KpiPackageComponent" AS ENUM ('GENERAL_SERVICE', 'FRONT_BRAKES', 'SPARK_PLUGS');

-- CreateEnum
CREATE TYPE "KpiRatingBand" AS ENUM ('EXCELLENT', 'MEETS_TARGET', 'NEEDS_IMPROVEMENT', 'BELOW_STANDARD');

-- CreateEnum
CREATE TYPE "KpiDelayReason" AS ENUM ('WAITING_FOR_PARTS', 'WAITING_CUSTOMER_AUTHORIZATION', 'BAY_OR_EQUIPMENT_UNAVAILABLE', 'MANAGER_OR_QC_HOLD', 'SYSTEM_OUTAGE', 'SAFETY_HOLD', 'EXCEPTIONAL_THERMAL_SAFETY_HOLD', 'TECHNICIAN_REASSIGNMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "KpiApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KpiEligibilityStatus" AS ENUM ('ELIGIBLE', 'MISSING_VEHICLE_CLASS', 'NOT_BENCHMARKED', 'MISSING_TIMESTAMPS', 'NO_PRIMARY_TECHNICIAN', 'CANCELLED_OR_VOID', 'INVALID_TIMER_DATA');

-- CreateTable
CREATE TABLE "kpi_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "effective_to" TIMESTAMPTZ,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "meets_tolerance_minutes" INTEGER NOT NULL DEFAULT 30,
    "needs_improvement_tolerance_minutes" INTEGER NOT NULL DEFAULT 60,
    "absolute_excellent_max_minutes" INTEGER NOT NULL DEFAULT 120,
    "absolute_meets_target_max_minutes" INTEGER NOT NULL DEFAULT 150,
    "absolute_needs_improvement_max_minutes" INTEGER NOT NULL DEFAULT 180,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kpi_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_benchmarks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_id" UUID NOT NULL,
    "vehicle_class" "VehicleServiceClass" NOT NULL,
    "package_type" "KpiPackageType" NOT NULL,
    "standard_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_service_components" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_type_id" UUID NOT NULL,
    "component" "KpiPackageComponent" NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kpi_service_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_kpi_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "vehicle_class" "VehicleServiceClass",
    "package_type" "KpiPackageType" NOT NULL,
    "standard_minutes" INTEGER,
    "custom_standard_minutes" INTEGER,
    "custom_standard_reason" TEXT,
    "custom_standard_by_user_id" UUID,
    "custom_standard_approved_at" TIMESTAMPTZ,
    "first_work_started_at" TIMESTAMPTZ,
    "first_submitted_to_qc_at" TIMESTAMPTZ,
    "raw_elapsed_minutes" INTEGER,
    "approved_excluded_minutes" INTEGER NOT NULL DEFAULT 0,
    "kpi_completion_minutes" INTEGER,
    "variance_minutes" INTEGER,
    "variance_percent" DOUBLE PRECISION,
    "absolute_completion_rating" "KpiRatingBand",
    "adjusted_technician_rating" "KpiRatingBand",
    "on_target" BOOLEAN NOT NULL DEFAULT false,
    "eligibility_status" "KpiEligibilityStatus" NOT NULL DEFAULT 'ELIGIBLE',
    "eligibility_reason" TEXT,
    "primary_technician_id" UUID,
    "is_shared_or_reassigned" BOOLEAN NOT NULL DEFAULT false,
    "had_rework" BOOLEAN NOT NULL DEFAULT false,
    "calculated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalised_at" TIMESTAMPTZ,
    "corrected_by_user_id" UUID,
    "corrected_at" TIMESTAMPTZ,
    "correction_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "work_order_kpi_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_delay_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "technician_id" UUID,
    "reason_code" "KpiDelayReason" NOT NULL,
    "description" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "duration_minutes" INTEGER,
    "requested_for_exclusion" BOOLEAN NOT NULL DEFAULT false,
    "approval_status" "KpiApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ,
    "rejection_reason" TEXT,
    "service_order_pause_id" UUID,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kpi_delay_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kpi_policies_version_key" ON "kpi_policies"("version");

-- CreateIndex
CREATE INDEX "kpi_policies_is_active_effective_from_idx" ON "kpi_policies"("is_active", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_benchmarks_policy_id_vehicle_class_package_type_key" ON "kpi_benchmarks"("policy_id", "vehicle_class", "package_type");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_service_components_service_type_id_key" ON "kpi_service_components"("service_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_kpi_snapshots_service_order_id_key" ON "work_order_kpi_snapshots"("service_order_id");

-- CreateIndex
CREATE INDEX "work_order_kpi_snapshots_adjusted_technician_rating_idx" ON "work_order_kpi_snapshots"("adjusted_technician_rating");

-- CreateIndex
CREATE INDEX "work_order_kpi_snapshots_package_type_idx" ON "work_order_kpi_snapshots"("package_type");

-- CreateIndex
CREATE INDEX "work_order_kpi_snapshots_primary_technician_id_idx" ON "work_order_kpi_snapshots"("primary_technician_id");

-- CreateIndex
CREATE INDEX "work_order_kpi_snapshots_eligibility_status_idx" ON "work_order_kpi_snapshots"("eligibility_status");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_delay_events_service_order_pause_id_key" ON "kpi_delay_events"("service_order_pause_id");

-- CreateIndex
CREATE INDEX "kpi_delay_events_service_order_id_idx" ON "kpi_delay_events"("service_order_id");

-- CreateIndex
CREATE INDEX "kpi_delay_events_approval_status_idx" ON "kpi_delay_events"("approval_status");

-- AddForeignKey
ALTER TABLE "kpi_benchmarks" ADD CONSTRAINT "kpi_benchmarks_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "kpi_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_service_components" ADD CONSTRAINT "kpi_service_components_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_kpi_snapshots" ADD CONSTRAINT "work_order_kpi_snapshots_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_kpi_snapshots" ADD CONSTRAINT "work_order_kpi_snapshots_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "kpi_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_delay_events" ADD CONSTRAINT "kpi_delay_events_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
