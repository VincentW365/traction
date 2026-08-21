-- CR-2026-091 — an unmapped service must not read as a technician's failure.
--
-- Before this, a job that could not be benchmarked landed in NOT_BENCHMARKED whether
-- the work genuinely had no agreed standard (a gearbox strip) or nobody had yet mapped
-- one of its services (an administrative gap). The two look identical in the data and
-- need opposite handling: the first is a finished answer, the second is somebody's
-- outstanding task.
--
-- It also kept the absolute completion rating, so a job held up by unmapped extra work
-- could show "Below Standard" — an implicitly negative result produced by missing
-- configuration rather than by the technician.
--
-- Fully additive. Existing snapshots keep their current status and default to
-- pending_benchmark_review = false: they were rated under the old rules and
-- retrospectively reclassifying them would rewrite results that are already known.

ALTER TYPE "KpiEligibilityStatus" ADD VALUE IF NOT EXISTS 'PENDING_BENCHMARK_REVIEW';

ALTER TABLE "work_order_kpi_snapshots"
  ADD COLUMN "pending_benchmark_review"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "benchmark_resolved_at"         TIMESTAMPTZ,
  ADD COLUMN "benchmark_resolved_by_user_id" UUID;

-- The review queue is read by "what is still outstanding?", so it is worth an index
-- even though the flag is false for almost every row.
CREATE INDEX "work_order_kpi_snapshots_pending_benchmark_review_idx"
  ON "work_order_kpi_snapshots"("pending_benchmark_review")
  WHERE "pending_benchmark_review" = true;
