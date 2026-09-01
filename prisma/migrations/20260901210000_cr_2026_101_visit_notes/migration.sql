-- CR-2026-101 — typed operational notes on a visit.
--
-- The customer's stated concern, an advisor's context note, a manager's
-- instruction and a technician's finding are different facts; one untyped
-- notes blob buries all of them. SAFETY and DATA_REPORT notes (a technician
-- flagging danger or incorrect master data they deliberately cannot edit)
-- carry requires_attention and surface to the advisor/manager; resolution is
-- recorded on the row, never by deletion.

CREATE TYPE "VisitNoteKind" AS ENUM (
  'CUSTOMER_CONCERN',
  'ADVISOR',
  'MANAGER',
  'TECHNICIAN',
  'SAFETY',
  'DATA_REPORT'
);

CREATE TABLE "visit_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "service_visit_id" UUID NOT NULL,
  "service_order_id" UUID,
  "kind" "VisitNoteKind" NOT NULL,
  "text" TEXT NOT NULL,
  "author_user_id" UUID NOT NULL,
  "author_role" TEXT NOT NULL,
  "requires_attention" BOOLEAN NOT NULL DEFAULT false,
  "resolved_by_user_id" UUID,
  "resolved_at" TIMESTAMPTZ,
  "resolution_notes" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "visit_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "visit_notes_service_visit_id_idx" ON "visit_notes"("service_visit_id");
CREATE INDEX "visit_notes_requires_attention_idx" ON "visit_notes"("requires_attention");

ALTER TABLE "visit_notes"
  ADD CONSTRAINT "visit_notes_service_visit_id_fkey"
  FOREIGN KEY ("service_visit_id") REFERENCES "service_visits"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
