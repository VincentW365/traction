-- CR-2026-087 parts 2 and 3 — senior-technician QC, and pre-inspection photos.
--
-- All additive: new nullable columns, one boolean with a default, and one new
-- table. No existing data is rewritten and nothing is dropped, so this is safe to
-- apply to a live database and trivially reversible.

-- 1. Seniority. There was no seniority attribute at all before this: "senior tech
--    sign-off" was RBAC standing in for it, so only a manager could sign and an
--    actual senior technician could not. Defaults false — a manager ticks the box.
ALTER TABLE "technicians"
  ADD COLUMN "is_senior" BOOLEAN NOT NULL DEFAULT false;

-- 2. Quality control attribution. A passed QC used to be an unattributed, unguarded
--    status transition — nothing recorded who did it, and nothing stopped the
--    technician who did the work from passing their own. (A FAILED QC was already
--    attributed, via service_order_reworks.opened_by_user_id.)
--
--    qc_assigned_technician_id is set in advance, when the job is assigned, so the
--    shop knows up front which senior technician owns the check.
ALTER TABLE "service_orders"
  ADD COLUMN "qc_assigned_technician_id" UUID,
  ADD COLUMN "qc_by_user_id" UUID,
  ADD COLUMN "qc_at" TIMESTAMPTZ;

-- 3. Pre-inspection photos, taken by the assigned technician on a tablet.
--    base64 data URL in TEXT, following the inspection_signatures.image_data
--    precedent: there is no object store here and Render's free plan has no
--    persistent disk, so the container filesystem cannot hold them.
CREATE TABLE "inspection_photos" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "inspection_id"   UUID NOT NULL,
  "image_data"      TEXT NOT NULL,
  "caption"         TEXT,
  "taken_by_user_id" UUID,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inspection_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inspection_photos_inspection_id_idx"
  ON "inspection_photos" ("inspection_id");

-- Cascade: photos are part of the inspection record, not independent evidence.
ALTER TABLE "inspection_photos"
  ADD CONSTRAINT "inspection_photos_inspection_id_fkey"
  FOREIGN KEY ("inspection_id") REFERENCES "vehicle_inspections" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
