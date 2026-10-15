-- CR-2026-117 — coming out of test routing becomes a decision management makes,
-- not an environment variable only the deployment holder can change.
--
-- Seeded FALSE. Test routing is the safe state and this migration must not be
-- what starts an installation writing to real customers; a manager turns it on
-- deliberately, in Settings, and the change is audited like any other rule.
--
-- The mailbox itself is NOT here and must never be: EMAIL_PROVIDER and the SMTP
-- host/user/password/from stay in deployment config. A credential in this table
-- is readable by every CONFIG_VIEW account, copied into the audit log's
-- before/after values on any edit, and present in every backup thereafter.
--
-- The test recipient is seeded empty, meaning "use whatever the environment
-- says". It is an address, not a secret, so it is safe to manage here.
--
-- Idempotent: re-running inserts nothing, and a value a manager has already set
-- is never overwritten.

INSERT INTO "business_rule_configs" ("id", "site_id", "rule_key", "value_json", "notes")
SELECT
  gen_random_uuid(),
  s."id",
  r.rule_key,
  r.value_json::jsonb,
  r.notes
FROM "sites" s
CROSS JOIN (
  VALUES
    (
      'notifications_live_sending',
      'false',
      'CR-2026-117: OFF routes every customer email to the test recipient. ON sends to real customers. Requires a mailbox to be connected in deployment config; the switch refuses otherwise.'
    ),
    (
      'notifications_test_email_to',
      '""',
      'CR-2026-117: where customer email goes while live sending is off. Empty means fall back to NOTIFICATION_TEST_EMAIL_TO from deployment config.'
    )
) AS r(rule_key, value_json, notes)
WHERE NOT EXISTS (
  SELECT 1
  FROM "business_rule_configs" b
  WHERE b."rule_key" = r.rule_key
    AND (b."site_id" = s."id" OR b."site_id" IS NULL)
);
