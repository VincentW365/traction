-- CR-2026-112 — drop the redundant "(Email)" suffix from template LABELS.
--
-- Seeded before this CR, each template was named for its channel, because there
-- were two: "Service due reminder (SMS)" and "Service due reminder (Email)".
-- With one channel the suffix is noise on every row of Setup → Notifications —
-- exactly the "partially completed multi-channel system" appearance this CR
-- exists to remove.
--
-- WHY THIS IS A MIGRATION AND NOT A RESEED
--   Seeding is create-if-missing (CR-2026-096), which is what protects a
--   manager's edited wording from every redeploy. That rule is correct and is
--   NOT being relaxed here.
--
-- WHAT IT TOUCHES, PRECISELY
--   `name` only — the label a manager reads in the admin list. The UI does not
--   expose `name` for editing, so this value is system-owned descriptive text,
--   never something a person chose.
--
--   `updated_by_user_id IS NULL` — only rows no human has ever touched. If a
--   manager has edited a template, this migration leaves the whole row alone.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH
--   `subject` and `body`. Those are customer-facing wording, they ARE editable
--   in the UI, and they belong to the owner. A deployment must never rewrite
--   what a customer reads. (Consequence, stated plainly in docs/131 §16b: a
--   deployment seeded before this CR still has a PICKUP_READY subject reading
--   "Ready for Pickup" while the screens say "Collection". That is a one-line
--   edit in Setup → Notifications, and it is the owner's to make.)
--
-- Idempotent and safe to re-run: a name without the suffix is left as it is.
--
-- ROLLBACK
--   Cosmetic and reversible: re-append the suffix, or edit the name in the
--   database. No behaviour, no history and no customer message depends on it.
UPDATE notification_templates
   SET name = btrim(regexp_replace(name, '\s*\(Email\)\s*$', ''))
 WHERE channel = 'EMAIL'
   AND updated_by_user_id IS NULL
   AND name ~ '\(Email\)\s*$';
