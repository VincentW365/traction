-- CR-2026-093 — saved job-sheet drafts. Fully additive: one document per visit,
-- holding the typed lines, ticks, directive and drawn signature. Filling the sheet
-- never changes the visit's operational records.

CREATE TABLE "job_sheet_drafts" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "service_visit_id"   UUID NOT NULL,
  "data"               JSONB NOT NULL,
  "signature_image"    TEXT,
  "updated_by_user_id" UUID,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ NOT NULL,

  CONSTRAINT "job_sheet_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_sheet_drafts_service_visit_id_key"
  ON "job_sheet_drafts"("service_visit_id");

ALTER TABLE "job_sheet_drafts"
  ADD CONSTRAINT "job_sheet_drafts_service_visit_id_fkey"
  FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
