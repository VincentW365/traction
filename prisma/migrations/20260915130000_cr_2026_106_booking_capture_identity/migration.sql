-- CR-2026-106 (docs/121 §D) — additive, nullable, no backfill.
-- Appointment: the odometer reading the customer reported when booking online.
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "customer_reported_mileage" INTEGER;

-- Customer: pending-identity review for self-service bookings that may duplicate
-- an existing record (flagged, never merged automatically).
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "identity_review_status" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "possible_duplicate_of_id" UUID;
CREATE INDEX IF NOT EXISTS "customers_identity_review_status_idx" ON "customers"("identity_review_status");
