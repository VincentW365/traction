-- CR-2026-100 — technician pause acknowledgement workflow + labour switch reason.
--
-- A technician-reported pause takes effect at the moment it was reported
-- (started_at, unchanged semantics — every existing duration calculation keeps
-- working). New columns record WHO the pause belongs to, whether it was entered
-- on the technician's behalf, the advisor/manager acknowledgement, and any
-- retroactive correction of the effective start — original preserved, never
-- overwritten.

CREATE TYPE "PauseApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "service_order_pauses"
  ADD COLUMN "technician_id" UUID,
  ADD COLUMN "entered_on_behalf" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "approval_status" "PauseApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "reviewed_by_user_id" UUID,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ,
  ADD COLUMN "review_notes" TEXT,
  ADD COLUMN "original_started_at" TIMESTAMPTZ,
  ADD COLUMN "corrected_by_user_id" UUID,
  ADD COLUMN "corrected_at" TIMESTAMPTZ,
  ADD COLUMN "correction_reason" TEXT;

-- Existing rows predate the acknowledgement workflow: they were recorded by
-- whoever pressed the button and stood unchallenged, so they read as APPROVED
-- history (the column default), not as a retroactive review backlog.

CREATE INDEX "service_order_pauses_approval_status_idx"
  ON "service_order_pauses" ("approval_status");

-- CR-2026-100 — a technician switching to another job while colleagues keep
-- working the current one closes only their own labour segment.
ALTER TYPE "SegmentEndReason" ADD VALUE 'SWITCHED_JOB';
