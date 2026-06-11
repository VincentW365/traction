-- CR-2026-019 (P1a) — Service Catalog / Price List.
-- Additive only: one new table, no ALTER to existing tables, no data changes.
-- NOTE: not applied during the P1a dry-run; applied only when catalog import is approved.

-- CreateTable
CREATE TABLE "service_catalog_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_code" TEXT,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "base_price" DECIMAL(12,2),
    "price_tax_inclusive" DECIMAL(12,2),
    "labor_price" DECIMAL(12,2),
    "parts_price" DECIMAL(12,2),
    "currency" TEXT DEFAULT 'JMD',
    "effective_from" TIMESTAMPTZ,
    "effective_to" TIMESTAMPTZ,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL,
    "raw_import_row" JSONB NOT NULL,
    "row_hash" TEXT NOT NULL,
    "service_type_id" UUID,
    "import_batch_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "service_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_catalog_items_row_hash_key" ON "service_catalog_items"("row_hash");

-- CreateIndex
CREATE INDEX "service_catalog_items_normalized_name_idx" ON "service_catalog_items"("normalized_name");

-- CreateIndex
CREATE INDEX "service_catalog_items_category_idx" ON "service_catalog_items"("category");

-- CreateIndex
CREATE INDEX "service_catalog_items_job_code_idx" ON "service_catalog_items"("job_code");

-- CreateIndex
CREATE INDEX "service_catalog_items_service_type_id_idx" ON "service_catalog_items"("service_type_id");
