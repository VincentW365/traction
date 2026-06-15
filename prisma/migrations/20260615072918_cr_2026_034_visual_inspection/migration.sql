-- CreateEnum
CREATE TYPE "InspectionStatus" AS ENUM ('DRAFT', 'COMPLETED', 'SIGNED_OFF', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InspectionItemResult" AS ENUM ('OK', 'FUTURE', 'IMMEDIATE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "BatteryTestResult" AS ENUM ('PASS', 'RECHARGE_RETEST', 'FAIL');

-- CreateEnum
CREATE TYPE "WheelPosition" AS ENUM ('LEFT_FRONT', 'RIGHT_FRONT', 'LEFT_REAR', 'RIGHT_REAR');

-- CreateEnum
CREATE TYPE "RotorOrDrum" AS ENUM ('ROTOR', 'DRUM');

-- CreateEnum
CREATE TYPE "InspectionCustomerDecision" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'DEFERRED');

-- CreateEnum
CREATE TYPE "RecommendationSeverity" AS ENUM ('FUTURE', 'IMMEDIATE');

-- CreateEnum
CREATE TYPE "InspectionSignatureRole" AS ENUM ('SENIOR_TECH', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "InspectionSignatureType" AS ENUM ('TYPED', 'DRAWN');

-- CreateTable
CREATE TABLE "inspection_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "inspection_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_template_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "allows_na" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "inspection_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_inspections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inspection_number" TEXT NOT NULL,
    "site_id" UUID NOT NULL,
    "service_visit_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "status" "InspectionStatus" NOT NULL DEFAULT 'DRAFT',
    "performed_by_user_id" UUID,
    "battery_test_result" "BatteryTestResult",
    "battery_factory_cca" INTEGER,
    "battery_actual_cca" INTEGER,
    "alignment_check_needed" BOOLEAN NOT NULL DEFAULT false,
    "wheel_balance_needed" BOOLEAN NOT NULL DEFAULT false,
    "brake_inspection_performed" BOOLEAN NOT NULL DEFAULT true,
    "prior_body_damage_notes" TEXT,
    "comments" TEXT,
    "signed_off_by_user_id" UUID,
    "signed_off_at" TIMESTAMPTZ,
    "customer_ack_by_user_id" UUID,
    "customer_ack_at" TIMESTAMPTZ,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vehicle_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inspection_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "result" "InspectionItemResult" NOT NULL DEFAULT 'OK',
    "note" TEXT,

    CONSTRAINT "inspection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_wheel_measurements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inspection_id" UUID NOT NULL,
    "position" "WheelPosition" NOT NULL,
    "brake_lining_mm" DOUBLE PRECISION,
    "tire_tread_32nds" INTEGER,
    "wear_pattern" TEXT,
    "tire_pressure_before_psi" INTEGER,
    "tire_pressure_after_psi" INTEGER,
    "rotor_or_drum" "RotorOrDrum",

    CONSTRAINT "inspection_wheel_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_recommendations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inspection_id" UUID NOT NULL,
    "inspection_item_id" UUID,
    "severity" "RecommendationSeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "suggested_service_type_code" TEXT,
    "customer_decision" "InspectionCustomerDecision" NOT NULL DEFAULT 'PENDING',
    "decision_by_user_id" UUID,
    "decision_at" TIMESTAMPTZ,
    "resulting_service_order_id" UUID,
    "resulting_service_order_item_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "inspection_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_signatures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inspection_id" UUID NOT NULL,
    "role" "InspectionSignatureRole" NOT NULL,
    "type" "InspectionSignatureType" NOT NULL,
    "typed_name" TEXT,
    "image_data" TEXT,
    "signed_by_user_id" UUID,
    "signed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspection_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inspection_templates_version_key" ON "inspection_templates"("version");

-- CreateIndex
CREATE INDEX "inspection_template_items_template_id_idx" ON "inspection_template_items"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_inspections_inspection_number_key" ON "vehicle_inspections"("inspection_number");

-- CreateIndex
CREATE INDEX "vehicle_inspections_site_id_status_idx" ON "vehicle_inspections"("site_id", "status");

-- CreateIndex
CREATE INDEX "vehicle_inspections_service_visit_id_idx" ON "vehicle_inspections"("service_visit_id");

-- CreateIndex
CREATE INDEX "vehicle_inspections_vehicle_id_idx" ON "vehicle_inspections"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_inspections_customer_id_idx" ON "vehicle_inspections"("customer_id");

-- CreateIndex
CREATE INDEX "vehicle_inspections_status_idx" ON "vehicle_inspections"("status");

-- CreateIndex
CREATE INDEX "inspection_items_inspection_id_idx" ON "inspection_items"("inspection_id");

-- CreateIndex
CREATE INDEX "inspection_wheel_measurements_inspection_id_idx" ON "inspection_wheel_measurements"("inspection_id");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_wheel_measurements_inspection_id_position_key" ON "inspection_wheel_measurements"("inspection_id", "position");

-- CreateIndex
CREATE INDEX "inspection_recommendations_inspection_id_idx" ON "inspection_recommendations"("inspection_id");

-- CreateIndex
CREATE INDEX "inspection_signatures_inspection_id_idx" ON "inspection_signatures"("inspection_id");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_signatures_inspection_id_role_key" ON "inspection_signatures"("inspection_id", "role");

-- AddForeignKey
ALTER TABLE "inspection_template_items" ADD CONSTRAINT "inspection_template_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "inspection_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_service_visit_id_fkey" FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "inspection_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_items" ADD CONSTRAINT "inspection_items_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "vehicle_inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_wheel_measurements" ADD CONSTRAINT "inspection_wheel_measurements_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "vehicle_inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_recommendations" ADD CONSTRAINT "inspection_recommendations_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "vehicle_inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_recommendations" ADD CONSTRAINT "inspection_recommendations_inspection_item_id_fkey" FOREIGN KEY ("inspection_item_id") REFERENCES "inspection_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_signatures" ADD CONSTRAINT "inspection_signatures_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "vehicle_inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
