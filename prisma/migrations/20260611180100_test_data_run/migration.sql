-- CR-2026-020 (T-a) — Test Data Sandbox: run registry + anchor tags.
-- Runs AFTER 20260611180000_test_data_run_integration_enum (enum value added in
-- its own migration). ADDITIVE ONLY: one new enum, one new table, and three
-- NULLABLE columns (with indexes + FKs) on existing tables. No existing column
-- is altered, no data is changed, nothing is dropped.
-- NOTE: NOT applied during T-a review; applied only when approved.

-- CreateEnum
CREATE TYPE "TestDataRunStatus" AS ENUM ('ACTIVE', 'CLEANED_UP');

-- CreateTable
CREATE TABLE "test_data_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "label" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "notes" TEXT,
    "status" "TestDataRunStatus" NOT NULL DEFAULT 'ACTIVE',
    "cleaned_at" TIMESTAMPTZ,
    "creation_summary" JSONB,
    "cleanup_summary" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "test_data_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "test_data_runs_label_key" ON "test_data_runs"("label");

-- CreateIndex
CREATE INDEX "test_data_runs_status_idx" ON "test_data_runs"("status");

-- AlterTable
ALTER TABLE "customers" ADD COLUMN "test_data_run_id" UUID;

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN "test_data_run_id" UUID;

-- AlterTable
ALTER TABLE "service_visits" ADD COLUMN "test_data_run_id" UUID;

-- CreateIndex
CREATE INDEX "customers_test_data_run_id_idx" ON "customers"("test_data_run_id");

-- CreateIndex
CREATE INDEX "vehicles_test_data_run_id_idx" ON "vehicles"("test_data_run_id");

-- CreateIndex
CREATE INDEX "service_visits_test_data_run_id_idx" ON "service_visits"("test_data_run_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_test_data_run_id_fkey" FOREIGN KEY ("test_data_run_id") REFERENCES "test_data_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_test_data_run_id_fkey" FOREIGN KEY ("test_data_run_id") REFERENCES "test_data_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_visits" ADD CONSTRAINT "service_visits_test_data_run_id_fkey" FOREIGN KEY ("test_data_run_id") REFERENCES "test_data_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
