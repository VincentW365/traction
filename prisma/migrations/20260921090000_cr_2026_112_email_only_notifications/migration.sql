-- CR-2026-112 — Customer Email Notifications.
--
-- Additive only: five new NotificationReason values. No existing row is read,
-- rewritten or reinterpreted; no column is added, dropped or retyped.
--
-- WHY THESE FIVE
--   CUSTOMER_ACTION_REQUIRED  the customer must authorise, approve or decide
--                             something before work can continue.
--   APPOINTMENT_CONFIRMATION  booking confirmed (staff or self-service).
--   APPOINTMENT_CHANGED       the appointment moved.
--   APPOINTMENT_CANCELLED     the appointment was cancelled.
--   APPOINTMENT_REMINDER      the pre-appointment reminder sweep.
--
--   Before this CR the appointment messages were rendered in application code and
--   carried NO reason at all, so they could not be filtered, reported on, or
--   reworded by a manager. They now flow through the same template store, log and
--   audit trail as every other customer email.
--
-- WHAT IS DELIBERATELY NOT CHANGED
--   `NotificationChannel` keeps SMS and WHATSAPP. This release sends EMAIL only,
--   but historical SMS rows must stay readable and a future SMS phase must not
--   need a destructive migration. Nothing selects those values at runtime.
--
--   PICKUP_READY is NOT renamed to VEHICLE_READY. The screens now say "Vehicle
--   Ready for Collection"; renaming the stored value would rewrite history for a
--   label, and enum renames are not reversible in place.
--
-- DEPLOY SAFETY
--   `ADD VALUE IF NOT EXISTS` is idempotent and re-runnable. PostgreSQL 12+
--   allows it inside a transaction (Prisma wraps migrations in one); the new
--   values are not USED in this migration. Deployment order is migrate →
--   generate → start, so no running process writes these values before the type
--   carries them.
--
-- ROLLBACK
--   PostgreSQL cannot DROP an enum value. Leaving the unused values in place is
--   the preferred rollback and is harmless: reason is nullable and every legacy
--   row is unaffected. Only if the feature were abandoned entirely would the
--   type need recreating, and that would first require repointing any row that
--   uses one of the new values (UPDATE notification_logs SET reason = NULL).
ALTER TYPE "NotificationReason" ADD VALUE IF NOT EXISTS 'CUSTOMER_ACTION_REQUIRED';
ALTER TYPE "NotificationReason" ADD VALUE IF NOT EXISTS 'APPOINTMENT_CONFIRMATION';
ALTER TYPE "NotificationReason" ADD VALUE IF NOT EXISTS 'APPOINTMENT_CHANGED';
ALTER TYPE "NotificationReason" ADD VALUE IF NOT EXISTS 'APPOINTMENT_CANCELLED';
ALTER TYPE "NotificationReason" ADD VALUE IF NOT EXISTS 'APPOINTMENT_REMINDER';
