-- CR-2026-099 — self-service password change: refresh tokens issued before
-- password_changed_at are rejected, ending old sessions after a change/reset.
ALTER TABLE "user_accounts" ADD COLUMN "password_changed_at" TIMESTAMPTZ;
