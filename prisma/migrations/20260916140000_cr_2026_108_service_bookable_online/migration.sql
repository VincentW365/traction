-- CR-2026-108 Stage 4A — self-service booking configuration on ServiceType.
--
-- ADDITIVE ONLY. Three nullable/defaulted columns; no existing row is read,
-- rewritten or reinterpreted, and nothing a customer sees changes on deploy.
--
-- bookable_online defaults FALSE deliberately: a service must not become publicly
-- bookable merely by being active. Diagnostic and highly variable work has to be
-- enabled on purpose.
--
-- That default would empty the public service list the moment it were enforced,
-- so enforcement is a SEPARATE, configurable switch:
--   business_rule_configs.booking_enforce_online_bookable  (seeded false)
-- While it is false the existing selection behaviour is preserved exactly. The
-- switch is flipped through configuration, never by a redeploy.
--
-- booking_buffer_minutes affects SCHEDULING OCCUPANCY only. The customer is still
-- quoted the service duration; the buffer is workshop turnaround, not repair time,
-- and presenting it as repair time would misinform them.
--
-- ROLLBACK: drop the three columns. No data depends on them until an administrator
-- configures services and enables enforcement.
ALTER TABLE "service_types"
  ADD COLUMN IF NOT EXISTS "bookable_online"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "customer_facing_name"   TEXT,
  ADD COLUMN IF NOT EXISTS "booking_buffer_minutes" INTEGER NOT NULL DEFAULT 0;
