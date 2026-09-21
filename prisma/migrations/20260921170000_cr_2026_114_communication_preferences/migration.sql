-- CR-2026-114 — "we never asked" is not "they said no".
--
-- THE PROBLEM
--   `customers.notification_opt_in_email` is a boolean, so it has exactly two
--   states for a question with three answers. The import wrote FALSE on 6,857 of
--   6,901 customers because no affirmative answer was available — not because
--   those customers refused anything. Every screen that read that column
--   presented the absence of an answer as a customer decision.
--
--   CR-2026-113 stopped it doing operational harm (transactional email is no
--   longer gated on it). This migration stops it telling a falsehood.
--
-- THE BACKFILL RULE, AND WHY
--   false → UNKNOWN  (source IMPORTED_UNKNOWN, captured_at NULL)
--       There is no evidence anywhere in this database that these customers were
--       asked and refused. Recording them as DECLINED would invent a decision.
--       UNKNOWN blocks marketing exactly as false did, so no customer starts
--       receiving anything they were not already receiving — the difference is
--       entirely in what staff are TOLD, and in what a later real answer can
--       overwrite without pretending to contradict the customer.
--
--   true  → ALLOWED  (source MIGRATED, captured_at NULL)
--       This is the value the platform has been acting on, and it is permissive,
--       so representing it as ALLOWED changes no behaviour. `captured_at` stays
--       NULL because we do not know when, or whether, anyone actually asked.
--
--   NOBODY becomes DECLINED here. DECLINED is only ever written by a person
--   recording a customer's actual words, from CR-2026-114 onwards.
--
-- SCOPE
--   EMAIL / MARKETING only. Transactional and reminder email are not gated on a
--   preference (CR-2026-113), so seeding rows for them would manufacture
--   questions nobody asked. A purpose with no row reads UNKNOWN, which is true.
--
-- THE OLD COLUMN
--   `notification_opt_in_email` is NOT dropped. It stays as a legacy PROJECTION
--   of the EMAIL/MARKETING row, written in the same transaction by one service
--   method (docs/133 §3). Dropping it in the same change as introducing the
--   table would put a schema migration and a behaviour migration on the same
--   deploy, with no way to roll one back without the other.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING, so a re-run adds nothing and overwrites
-- no answer a customer has since given.
--
-- ROLLBACK: drop the table and the two enums. The boolean still carries the
-- operative value, so nothing is lost but the provenance.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommunicationPreferenceStatus') THEN
    CREATE TYPE "CommunicationPreferenceStatus" AS ENUM ('UNKNOWN', 'ALLOWED', 'DECLINED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommunicationPreferenceSource') THEN
    CREATE TYPE "CommunicationPreferenceSource" AS ENUM ('ONLINE_BOOKING', 'CUSTOMER_PROFILE', 'STAFF_CAPTURED', 'IMPORTED_UNKNOWN', 'MIGRATED');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "customer_communication_preferences" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "customer_id"         UUID NOT NULL,
  "channel"             "NotificationChannel" NOT NULL,
  "purpose"             "CommunicationPurpose" NOT NULL,
  "status"              "CommunicationPreferenceStatus" NOT NULL DEFAULT 'UNKNOWN',
  "source"              "CommunicationPreferenceSource" NOT NULL,
  "captured_at"         TIMESTAMPTZ,
  "captured_by_user_id" UUID,
  "note"                TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_communication_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "customer_communication_preferences_customer_id_channel_purpose_key"
  ON "customer_communication_preferences" ("customer_id", "channel", "purpose");
CREATE INDEX IF NOT EXISTS "customer_communication_preferences_status_idx"
  ON "customer_communication_preferences" ("status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customer_communication_preferences_customer_id_fkey'
  ) THEN
    ALTER TABLE "customer_communication_preferences"
      ADD CONSTRAINT "customer_communication_preferences_customer_id_fkey"
      FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customer_communication_preferences_captured_by_user_id_fkey'
  ) THEN
    ALTER TABLE "customer_communication_preferences"
      ADD CONSTRAINT "customer_communication_preferences_captured_by_user_id_fkey"
      FOREIGN KEY ("captured_by_user_id") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- The backfill.
DO $$
DECLARE
  unknown_rows integer;
  allowed_rows integer;
BEGIN
  INSERT INTO "customer_communication_preferences"
    ("customer_id", "channel", "purpose", "status", "source", "captured_at", "note")
  SELECT
    c.id,
    'EMAIL',
    'MARKETING',
    CASE WHEN c.notification_opt_in_email THEN 'ALLOWED'::"CommunicationPreferenceStatus"
         ELSE 'UNKNOWN'::"CommunicationPreferenceStatus" END,
    CASE WHEN c.notification_opt_in_email THEN 'MIGRATED'::"CommunicationPreferenceSource"
         ELSE 'IMPORTED_UNKNOWN'::"CommunicationPreferenceSource" END,
    NULL,
    CASE WHEN c.notification_opt_in_email
         THEN 'CR-2026-114 — backfilled from a permissive opt-in boolean. No capture date is known.'
         ELSE 'CR-2026-114 — backfilled from an opt-in boolean of false, which recorded the ABSENCE of an answer, not a refusal.' END
  FROM customers c
  ON CONFLICT ("customer_id", "channel", "purpose") DO NOTHING;

  SELECT count(*) INTO unknown_rows FROM customer_communication_preferences WHERE status = 'UNKNOWN';
  SELECT count(*) INTO allowed_rows FROM customer_communication_preferences WHERE status = 'ALLOWED';

  INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_json, after_json, reason_code, notes)
  VALUES (
    NULL,
    'CUSTOMER_COMMUNICATION_PREFERENCES_BACKFILLED',
    'Customer',
    NULL,
    jsonb_build_object('source', 'customers.notification_opt_in_email'),
    jsonb_build_object('unknown', unknown_rows, 'allowed', allowed_rows, 'declined', 0),
    'PREFERENCE_PROVENANCE',
    'CR-2026-114 — EMAIL/MARKETING preferences created from the legacy boolean. false became UNKNOWN (absence of an answer), true became ALLOWED. No customer was recorded as having DECLINED: nothing in the data evidences a refusal.'
  );

  RAISE NOTICE 'CR-2026-114 preferences: % UNKNOWN, % ALLOWED, 0 DECLINED', unknown_rows, allowed_rows;
END
$$;
