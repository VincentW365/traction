-- CR-2026-019 (P1b) — Service Job Mapping (job -> catalog).
-- Additive only: two enums + one new table, no ALTER to existing tables, no data changes.
-- NOTE: not applied during the P1b dry-run; applied only when mapping write is approved.

-- CreateEnum
CREATE TYPE "ServiceMatchMethod" AS ENUM ('EXACT', 'NORMALIZED', 'FUZZY', 'MANUAL', 'NONE');

-- CreateEnum
CREATE TYPE "ServiceMatchStatus" AS ENUM ('AUTO_MATCHED', 'NEEDS_REVIEW', 'CONFIRMED', 'REJECTED', 'UNMAPPED');

-- CreateTable
CREATE TABLE "service_job_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "service_order_id" UUID NOT NULL,
    "service_order_item_id" UUID,
    "catalog_item_id" UUID,
    "raw_text" TEXT,
    "confidence" DOUBLE PRECISION,
    "match_method" "ServiceMatchMethod" NOT NULL,
    "status" "ServiceMatchStatus" NOT NULL,
    "segment_hash" TEXT NOT NULL,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "import_batch_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_job_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_job_mappings_segment_hash_key" ON "service_job_mappings"("segment_hash");

-- CreateIndex
CREATE INDEX "service_job_mappings_service_order_id_idx" ON "service_job_mappings"("service_order_id");

-- CreateIndex
CREATE INDEX "service_job_mappings_catalog_item_id_idx" ON "service_job_mappings"("catalog_item_id");

-- CreateIndex
CREATE INDEX "service_job_mappings_status_idx" ON "service_job_mappings"("status");
