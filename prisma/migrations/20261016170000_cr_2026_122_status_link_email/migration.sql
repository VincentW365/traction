-- CR-2026-122 — a customer can be emailed their status link from the status-link
-- card on the queue ticket (and from the check-in confirmation). The email is a
-- notification like any other: its own reason, its own manager-editable template
-- (STATUS_LINK_EMAIL, seeded create-if-missing by the API), routed, logged and
-- audited through the shared composer. Additive; idempotent.

ALTER TYPE "NotificationReason" ADD VALUE IF NOT EXISTS 'STATUS_LINK';
