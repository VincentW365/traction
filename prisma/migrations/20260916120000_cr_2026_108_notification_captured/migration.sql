-- CR-2026-108 Stage 1 — capture (never transmit) notifications about TEST records.
--
-- Additive only: a new enum value. No existing row is read, rewritten or
-- reinterpreted, and no application behaviour changes for genuine customers.
--
-- CAPTURED is deliberately distinct from the states already present:
--   FAILED    something went wrong          (nothing went wrong here)
--   simulated no provider was configured    (a provider may well be configured)
--   testRouted global TEST mode redirected  (nothing was redirected; it was withheld)
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'CAPTURED';
