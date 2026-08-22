-- CR-2026-093 — Inspection hub: optional vehicle inspections, photo pre-inspections.
--
-- Enum values are added by the preceding migration, because Postgres refuses to use a
-- new enum value in the transaction that created it.
--
-- Fully additive. Three things this migration is careful NOT to do:
--
--  * It does not rewrite a single historical inspection result. Existing rows were
--    completed under a schema whose default was OK, so a stored OK may mean either
--    "checked and fine" or "never looked at" — nobody now can tell which. Guessing
--    either way would put words in a technician's mouth about work done months ago.
--    Only the DEFAULT for NEW items changes.
--  * It does not delete the legacy base64 `image_data` column. Photographs taken
--    before the storage boundary existed are still evidence and must stay viewable.
--    The column becomes nullable and is never written again.
--  * It does not touch inspection ids, numbers, signatures, recommendations or audit
--    history.

-- ---------------------------------------------------------------------------
-- Templates gain a kind; the pre-inspection workflow needs one of its own.
-- ---------------------------------------------------------------------------
ALTER TABLE "inspection_templates"
  ADD COLUMN "kind" "InspectionKind" NOT NULL DEFAULT 'VEHICLE_INSPECTION';

-- Presentation only: which column of the paper form an item belongs in.
ALTER TABLE "inspection_template_items"
  ADD COLUMN "form_column" TEXT NOT NULL DEFAULT 'LEFT';

-- The right-hand column of the approved form. Battery sits opposite Interior/Exterior;
-- the other right-column sections are measurements and free text, not checklist items.
UPDATE "inspection_template_items"
SET "form_column" = 'RIGHT'
WHERE upper("category") LIKE '%BATTERY%';

-- ---------------------------------------------------------------------------
-- Inspections: kind, skip/cancel outcomes, pre-inspection fields
-- ---------------------------------------------------------------------------
ALTER TABLE "vehicle_inspections"
  ADD COLUMN "kind"                  "InspectionKind" NOT NULL DEFAULT 'VEHICLE_INSPECTION',
  ADD COLUMN "skipped_at"            TIMESTAMPTZ,
  ADD COLUMN "skipped_by_user_id"    UUID,
  ADD COLUMN "skip_reason"           TEXT,
  ADD COLUMN "cancelled_at"          TIMESTAMPTZ,
  ADD COLUMN "cancelled_by_user_id"  UUID,
  ADD COLUMN "cancel_reason"         TEXT,
  ADD COLUMN "completed_by_user_id"  UUID,
  ADD COLUMN "general_condition"     TEXT,
  ADD COLUMN "visible_damage"        BOOLEAN,
  ADD COLUMN "damage_notes"          TEXT,
  ADD COLUMN "items_left_inside"     TEXT,
  ADD COLUMN "warning_lights"        TEXT,
  ADD COLUMN "fuel_level_note"       TEXT,
  ADD COLUMN "odometer_reading"      INTEGER,
  ADD COLUMN "no_photo_reason"       "NoPhotoReason",
  ADD COLUMN "no_photo_reason_note"  TEXT;

CREATE INDEX "vehicle_inspections_site_id_kind_status_idx"
  ON "vehicle_inspections"("site_id", "kind", "status");
CREATE INDEX "vehicle_inspections_kind_idx" ON "vehicle_inspections"("kind");

-- ---------------------------------------------------------------------------
-- New item default
-- ---------------------------------------------------------------------------
-- Applies to rows created from here on. Existing rows keep whatever they hold.
ALTER TABLE "inspection_items" ALTER COLUMN "result" SET DEFAULT 'NOT_INSPECTED';

-- ---------------------------------------------------------------------------
-- Photos: metadata row, bytes behind a storage boundary
-- ---------------------------------------------------------------------------
ALTER TABLE "inspection_photos"
  ADD COLUMN "storage_key"          TEXT,
  ADD COLUMN "original_filename"    TEXT,
  ADD COLUMN "sanitized_filename"   TEXT,
  ADD COLUMN "mime_type"            TEXT,
  ADD COLUMN "byte_size"            INTEGER,
  ADD COLUMN "width"                INTEGER,
  ADD COLUMN "height"               INTEGER,
  ADD COLUMN "checksum_sha256"      CHAR(64),
  ADD COLUMN "thumbnail_key"        TEXT,
  ADD COLUMN "category"             "InspectionPhotoCategory" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "sort_order"           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "is_primary"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "uploaded_by_user_id"  UUID,
  ADD COLUMN "uploaded_at"          TIMESTAMPTZ,
  ADD COLUMN "supersedes_photo_id"  UUID,
  ADD COLUMN "superseded_at"        TIMESTAMPTZ,
  ADD COLUMN "corrected_by_user_id" UUID,
  ADD COLUMN "correction_reason"    TEXT,
  ADD COLUMN "deleted_at"           TIMESTAMPTZ,
  ADD COLUMN "deleted_by_user_id"   UUID,
  ADD COLUMN "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Legacy rows carry their bytes inline; new rows never will.
ALTER TABLE "inspection_photos" ALTER COLUMN "image_data" DROP NOT NULL;

-- Backfill what the old rows can honestly supply. Everything else stays null rather
-- than being invented: a fabricated checksum is worse than an absent one.
UPDATE "inspection_photos"
SET "uploaded_at" = "created_at",
    "uploaded_by_user_id" = "taken_by_user_id"
WHERE "uploaded_at" IS NULL;

CREATE INDEX "inspection_photos_inspection_id_deleted_at_idx"
  ON "inspection_photos"("inspection_id", "deleted_at");
CREATE INDEX "inspection_photos_checksum_sha256_idx"
  ON "inspection_photos"("checksum_sha256");

-- A photo row must hold its bytes somewhere: either the new storage key or the legacy
-- inline payload. Neither means the row describes nothing.
ALTER TABLE "inspection_photos"
  ADD CONSTRAINT "inspection_photos_has_payload"
  CHECK ("storage_key" IS NOT NULL OR "image_data" IS NOT NULL);
