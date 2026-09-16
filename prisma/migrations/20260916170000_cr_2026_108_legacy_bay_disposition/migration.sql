-- CR-2026-108 — a legacy bay can be RESOLVED without being LINKED.
--
-- The reconciliation gate previously required every legacy WorkBay to be matched
-- to a WorkResource before Stage 5C could begin. On a shop floor that has been
-- physically reorganised that is not always true: a bay may have been demolished,
-- absorbed into a larger one, or replaced by an arrangement that corresponds to no
-- single resource. Forcing a link in those cases would manufacture a false fact —
-- and it would be a fact the resource-aware engine then reasons from.
--
-- So a bay is resolved when it is EITHER linked to its current resource OR
-- explicitly dispositioned as historical-only, replaced, or retired, with a note
-- and an audited actor.
--
-- ADDITIVE ONLY. No assignment, work order or history row is touched: this adds
-- four columns to work_bays and nothing else. Every existing bay lands on
-- UNRESOLVED, which is exactly where the reconciliation currently stands.
--
-- Deliberately separate from `work_bays.status`. That column says whether a bay is
-- active for scheduling; this one says how the physical walk accounted for it. One
-- column answering both questions would let a disposition silently change what the
-- scheduler sees.
--
-- ROLLBACK: drop the columns and the type. Nothing reads them except the
-- reconciliation view and the readiness gate, neither of which affects production.

CREATE TYPE "LegacyBayDisposition" AS ENUM (
  'UNRESOLVED',
  'HISTORICAL_ONLY',
  'REPLACED',
  'RETIRED'
);

ALTER TABLE "work_bays"
  ADD COLUMN IF NOT EXISTS "reconciliation_disposition" "LegacyBayDisposition" NOT NULL DEFAULT 'UNRESOLVED',
  ADD COLUMN IF NOT EXISTS "disposition_note"           TEXT,
  ADD COLUMN IF NOT EXISTS "dispositioned_at"           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "dispositioned_by_user_id"   UUID;
