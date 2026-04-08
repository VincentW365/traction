-- CreateEnum
CREATE TYPE "ResourceCategory" AS ENUM ('BAY', 'OVERFLOW', 'LIGHT_SLOT');

-- CreateEnum
CREATE TYPE "VehicleWeightClass" AS ENUM ('LIGHT', 'STANDARD', 'HEAVY');

-- CreateEnum
CREATE TYPE "IntegrationSystem" AS ENUM ('AUTOMATE', 'SAGE');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('SCHEDULED', 'SENT', 'ACKNOWLEDGED', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ReminderConfidence" AS ENUM ('CONFIRMED', 'ESTIMATED_HISTORY', 'DEFAULT_INTERVAL', 'OEM_SPEC');

-- CreateEnum
CREATE TYPE "PartsReadinessState" AS ENUM ('NOT_REQUIRED', 'UNCONFIRMED', 'REQUIRED_NOT_READY', 'READY');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'MANUAL_CALL';

-- AlterEnum
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE 'MANUAL';

-- AlterTable
ALTER TABLE "notification_logs" ADD COLUMN     "initiated_by_user_id" UUID,
ADD COLUMN     "template_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "queue_tickets" ADD COLUMN     "blocked_reason" TEXT,
ADD COLUMN     "ready_for_dispatch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "service_types" ADD COLUMN     "can_use_light_slot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "can_use_overflow" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "service_visits" ADD COLUMN     "customer_status_token" TEXT,
ADD COLUMN     "mileage_in" INTEGER,
ADD COLUMN     "mileage_out" INTEGER,
ADD COLUMN     "oil_brand_installed" TEXT,
ADD COLUMN     "oil_brand_requested" TEXT,
ADD COLUMN     "oil_grade_installed" TEXT,
ADD COLUMN     "oil_grade_requested" TEXT,
ADD COLUMN     "parts_readiness" "PartsReadinessState" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "token_expires_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "technician_assignments" ADD COLUMN     "resource_id" UUID;

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "vehicle_code" TEXT NOT NULL,
ADD COLUMN     "weight_class" "VehicleWeightClass";

-- CreateTable
CREATE TABLE "work_resources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resource_category" "ResourceCategory" NOT NULL,
    "max_vehicle_weight" "VehicleWeightClass",
    "lift_type" TEXT,
    "has_alignment" BOOLEAN NOT NULL DEFAULT false,
    "has_diagnostics" BOOLEAN NOT NULL DEFAULT false,
    "requires_mechanic" BOOLEAN NOT NULL DEFAULT true,
    "show_on_dispatch_board" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "capabilities" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "work_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_occupancies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "resource_id" UUID NOT NULL,
    "service_visit_id" UUID,
    "service_order_id" UUID,
    "technician_id" UUID,
    "occupied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_end_at" TIMESTAMPTZ,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',

    CONSTRAINT "resource_occupancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID NOT NULL,
    "resource_id" UUID,
    "appointment_id" UUID NOT NULL,
    "service_visit_id" UUID,
    "reserved_from" TIMESTAMPTZ NOT NULL,
    "reserved_until" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "claimed_at" TIMESTAMPTZ,
    "expired_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_system_refs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system" "IntegrationSystem" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "sync_status" TEXT NOT NULL DEFAULT 'PENDING',
    "last_sync_at" TIMESTAMPTZ,
    "last_sync_error" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "external_system_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "recommendation_id" UUID,
    "reminder_type" TEXT NOT NULL,
    "confidence" "ReminderConfidence" NOT NULL,
    "scheduled_send_date" DATE,
    "estimated_due_date" DATE,
    "estimated_due_mileage" INTEGER,
    "status" "ReminderStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notification_log_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mechanic_day_availability" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "technician_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "shift_start" TEXT NOT NULL,
    "shift_end" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "mechanic_day_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_weight_suggestions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "make_pattern" TEXT NOT NULL,
    "model_pattern" TEXT,
    "year_from" INTEGER,
    "year_to" INTEGER,
    "suggested_weight_class" "VehicleWeightClass" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_weight_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_resources_site_id_code_key" ON "work_resources"("site_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "resource_occupancies_resource_id_key" ON "resource_occupancies"("resource_id");

-- CreateIndex
CREATE INDEX "resource_occupancies_service_visit_id_idx" ON "resource_occupancies"("service_visit_id");

-- CreateIndex
CREATE INDEX "resource_reservations_site_id_status_idx" ON "resource_reservations"("site_id", "status");

-- CreateIndex
CREATE INDEX "resource_reservations_appointment_id_idx" ON "resource_reservations"("appointment_id");

-- CreateIndex
CREATE INDEX "external_system_refs_system_external_id_idx" ON "external_system_refs"("system", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_system_refs_system_entity_type_entity_id_key" ON "external_system_refs"("system", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "maintenance_reminders_vehicle_id_idx" ON "maintenance_reminders"("vehicle_id");

-- CreateIndex
CREATE INDEX "maintenance_reminders_customer_id_idx" ON "maintenance_reminders"("customer_id");

-- CreateIndex
CREATE INDEX "maintenance_reminders_status_scheduled_send_date_idx" ON "maintenance_reminders"("status", "scheduled_send_date");

-- CreateIndex
CREATE INDEX "mechanic_day_availability_date_idx" ON "mechanic_day_availability"("date");

-- CreateIndex
CREATE UNIQUE INDEX "mechanic_day_availability_technician_id_date_key" ON "mechanic_day_availability"("technician_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "service_visits_customer_status_token_key" ON "service_visits"("customer_status_token");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vehicle_code_key" ON "vehicles"("vehicle_code");

-- AddForeignKey
ALTER TABLE "technician_assignments" ADD CONSTRAINT "technician_assignments_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "work_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_initiated_by_user_id_fkey" FOREIGN KEY ("initiated_by_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_resources" ADD CONSTRAINT "work_resources_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_occupancies" ADD CONSTRAINT "resource_occupancies_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "work_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_occupancies" ADD CONSTRAINT "resource_occupancies_service_visit_id_fkey" FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "work_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_reminders" ADD CONSTRAINT "maintenance_reminders_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_reminders" ADD CONSTRAINT "maintenance_reminders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_reminders" ADD CONSTRAINT "maintenance_reminders_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "maintenance_recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mechanic_day_availability" ADD CONSTRAINT "mechanic_day_availability_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

