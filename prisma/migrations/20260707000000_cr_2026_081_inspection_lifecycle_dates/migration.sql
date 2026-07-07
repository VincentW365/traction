-- CR-2026-081: additive inspection lifecycle timestamps for accurate records and
-- date filtering. Both nullable and un-backfilled — historical rows stay NULL and
-- reads fall back to signed_off_at / customer_ack_at / created_at. No data changes.
-- AlterTable
ALTER TABLE "vehicle_inspections" ADD COLUMN "completed_at" TIMESTAMPTZ;
ALTER TABLE "vehicle_inspections" ADD COLUMN "closed_at" TIMESTAMPTZ;
