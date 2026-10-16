-- CR-2026-121 — three management decisions applied to every existing database.
--
-- 1. Customer email goes to customers. CR-2026-117 seeded notifications_live_sending
--    FALSE as "the safe state", and because that rule wins over NOTIFICATION_MODE it
--    quietly put a deployment the owner had set to LIVE back into test routing:
--    every customer message went to the test address and the send still showed as
--    successful. Management's instruction (2026-10-16) is that real customers are
--    emailed. The open FALSE row is closed (history kept) and an open TRUE row is
--    written for every site that has none. Whether mail can actually leave still
--    depends on the mailbox in deployment config (EMAIL_PROVIDER=smtp); without one
--    a send is recorded as SIMULATED, visible on the Notifications screen, and is
--    never delivered to the wrong place.
--
-- 2. The Booking Simulator is removed — its testing is complete. Its switch is
--    closed so Settings stops listing a row for a tool that no longer exists.
--
-- 3. Wheel Alignment is no longer offered online: the photographic audit and
--    management's answer (2026-10-16) establish there is no alignment equipment.
--    The service stays in the catalogue for staff use.
--
-- Idempotent: re-running changes nothing.

UPDATE "business_rule_configs"
SET "effective_to" = now()
WHERE "rule_key" = 'notifications_live_sending'
  AND "effective_to" IS NULL
  AND "value_json" = 'false'::jsonb;

INSERT INTO "business_rule_configs" ("id", "site_id", "rule_key", "value_json", "notes")
SELECT
  gen_random_uuid(),
  s."id",
  'notifications_live_sending',
  'true'::jsonb,
  'CR-2026-121: ON — customer email goes to customers. OFF routes every customer email to the test recipient instead. Needs a mailbox connected in deployment config to actually send.'
FROM "sites" s
WHERE NOT EXISTS (
  SELECT 1
  FROM "business_rule_configs" b
  WHERE b."rule_key" = 'notifications_live_sending'
    AND b."effective_to" IS NULL
    AND (b."site_id" = s."id" OR b."site_id" IS NULL)
);

UPDATE "business_rule_configs"
SET "effective_to" = now()
WHERE "rule_key" = 'booking_simulator_enabled'
  AND "effective_to" IS NULL;

UPDATE "service_types"
SET "bookable_online" = false
WHERE "code" = 'TIR-02'
  AND "bookable_online" = true;
