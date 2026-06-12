-- CR-2026-023 (E-b) — TestDataRun.runType discriminator + optional expiresAt.
-- ADDITIVE ONLY: one new enum + two new columns. Existing rows get run_type='BATCH'
-- automatically (NOT NULL DEFAULT). No data rewrite, nothing dropped.

-- CreateEnum
CREATE TYPE "TestDataRunType" AS ENUM ('BATCH', 'DEV_LOGIN_SESSION');

-- AlterTable
ALTER TABLE "test_data_runs" ADD COLUMN "run_type" "TestDataRunType" NOT NULL DEFAULT 'BATCH';

-- AlterTable
ALTER TABLE "test_data_runs" ADD COLUMN "expires_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "test_data_runs_run_type_idx" ON "test_data_runs"("run_type");
