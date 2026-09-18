-- CR-2026-108 §1 — the count is confirmed; the identities are not.
--
-- Management confirmed that EIGHT heavy-lift bays exist physically. Nobody has
-- confirmed that BAY-01, BAY-02, BAY-03, BAY-06, BAY-07, BAY-08, BAY-09 and
-- BAY-10 are those eight bays — that mapping was inferred from names, lift types
-- and a code series. Those are two different facts and the platform had no way to
-- tell them apart, so a provisional mapping read exactly like a verified one.
--
-- These two columns make the difference representable: a manager confirms a row
-- IS the physical bay, and until then every report that counts it says so.
--
-- ADDITIVE ONLY. Every existing row lands on NULL, which is the truthful answer —
-- nobody has confirmed any of them. Nothing about capacity changes: an unconfirmed
-- identity still contributes its configured capacity, because the shop really does
-- have eight bays even if the labels are provisional. What changes is what the
-- readiness report is willing to CLAIM.
--
-- ROLLBACK: drop both columns. Only readiness reporting reads them.

ALTER TABLE "work_resources"
  ADD COLUMN IF NOT EXISTS "identity_confirmed_at"         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "identity_confirmed_by_user_id" UUID;
