-- CR-2026-113 — communication purpose, so consent applies to the right messages.
--
-- THE PROBLEM THIS SOLVES
--   Every customer email was gated on one flag, `notificationOptInEmail`. The
--   imported customer base carries that flag as FALSE on 6,857 of 6,901 records,
--   which meant an advisor had to "override" a customer's preference to send an
--   appointment confirmation or tell someone their car was ready. That is the
--   wrong shape: an override should be exceptional, not the daily path, and a
--   preference flag should not be worn down by routine use until it means
--   nothing.
--
--   The fix is not to manufacture consent by flipping 6,857 records. It is to
--   record WHY a message is being sent, and to apply the consent requirement to
--   the purposes the business decides it applies to.
--
-- ADDITIVE ONLY. No existing row changes meaning:
--   * notification_logs.purpose is NULL on every pre-CR row (unknown, not
--     assumed) and is set going forward.
--   * notification_templates.purpose defaults to TRANSACTIONAL, then the
--     statement at the end sets the three non-transactional rows explicitly.
--   * consent_overridden defaults to false, which is the truth for every
--     historical row: no override mechanism existed when they were written.
--   * No customer preference record is touched by this migration. None.
--
-- POLICY LIVES IN CONFIGURATION, NOT HERE
--   Which purposes require recorded consent is the business rule
--   `notification_purposes_requiring_consent` (seeded default: ["MARKETING"]).
--   Changing the policy is a settings change, not a deployment.
--
-- ROLLBACK
--   Drop the three columns and the type. Nothing depends on them existing, and
--   no customer-facing behaviour is encoded in the data itself.

-- 1. The purpose vocabulary.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommunicationPurpose') THEN
    CREATE TYPE "CommunicationPurpose" AS ENUM ('TRANSACTIONAL', 'REMINDER', 'MARKETING');
  END IF;
END
$$;

-- 2. What a sent message was sent under, and whether a preference was overridden.
ALTER TABLE "notification_logs"
  ADD COLUMN IF NOT EXISTS "purpose" "CommunicationPurpose",
  ADD COLUMN IF NOT EXISTS "consent_overridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "consent_override_reason" TEXT;

-- 3. What a template is FOR — configuration a manager can change.
ALTER TABLE "notification_templates"
  ADD COLUMN IF NOT EXISTS "purpose" "CommunicationPurpose" NOT NULL DEFAULT 'TRANSACTIONAL';

-- 4. The three rows that are not transactional, set by REASON (never by key, so
--    a renamed template row still lands correctly). Re-runnable: the WHERE makes
--    it a no-op once applied, and a manager's later change is not undone here
--    because this runs once, in a migration, not on every deploy.
UPDATE "notification_templates"
   SET "purpose" = 'MARKETING'
 WHERE "reason" IN ('SERVICE_DUE')
   AND "purpose" = 'TRANSACTIONAL';

UPDATE "notification_templates"
   SET "purpose" = 'REMINDER'
 WHERE "reason" IN ('APPOINTMENT_REMINDER')
   AND "purpose" = 'TRANSACTIONAL';
