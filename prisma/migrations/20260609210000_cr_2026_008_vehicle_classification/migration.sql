-- CreateEnum
CREATE TYPE "ClassificationStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ClassificationConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'NONE');

-- CreateEnum
CREATE TYPE "ClassificationSource" AS ENUM ('MAKE_MODEL_LOOKUP', 'MANUAL', 'CHECK_IN');

-- AlterTable
ALTER TABLE "vehicle_weight_suggestions" ADD COLUMN     "suggested_service_class" "VehicleServiceClass";

-- CreateTable
CREATE TABLE "vehicle_classifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vehicle_id" UUID NOT NULL,
    "status" "ClassificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "suggested_service_class" "VehicleServiceClass",
    "suggested_weight_class" "VehicleWeightClass",
    "confidence" "ClassificationConfidence" NOT NULL DEFAULT 'NONE',
    "source" "ClassificationSource" NOT NULL DEFAULT 'MAKE_MODEL_LOOKUP',
    "confirmed_service_class" "VehicleServiceClass",
    "confirmed_weight_class" "VehicleWeightClass",
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vehicle_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_classifications_vehicle_id_key" ON "vehicle_classifications"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_classifications_status_idx" ON "vehicle_classifications"("status");

-- AddForeignKey
ALTER TABLE "vehicle_classifications" ADD CONSTRAINT "vehicle_classifications_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_classifications" ADD CONSTRAINT "vehicle_classifications_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

