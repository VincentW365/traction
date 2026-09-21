-- CR-2026-116 — the Booking Simulator becomes a switch the business owns.
--
-- Seeded TRUE, per site, and only where no row already governs the key. The
-- simulator works today; introducing its switch must not be the thing that
-- removes it. Turning it off is a decision a manager makes in Settings, where
-- it is versioned and audited like every other business rule — not a side
-- effect of a deployment.
--
-- Idempotent: re-running inserts nothing, and a value already set by a manager
-- is never overwritten.

INSERT INTO "business_rule_configs" ("id", "site_id", "rule_key", "value_json", "notes")
SELECT
  gen_random_uuid(),
  s."id",
  'booking_simulator_enabled',
  'true'::jsonb,
  'CR-2026-116: shows or hides Setup -> Booking Simulator and its test-booking sessions. Off also refuses the endpoints behind it, so the tool is genuinely gone rather than merely unlisted.'
FROM "sites" s
WHERE NOT EXISTS (
  SELECT 1
  FROM "business_rule_configs" b
  WHERE b."rule_key" = 'booking_simulator_enabled'
    AND (b."site_id" = s."id" OR b."site_id" IS NULL)
);
