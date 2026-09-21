/**
 * CR-2026-112 — the operational sentences the front desk reads about customer
 * email, kept in one place so every screen says the same thing. These mirror
 * the API's own wording (apps/api/src/modules/notifications/notification-messages.ts).
 */

/** No email address on file — what staff are told, and what to do about it. */
export const NO_EMAIL_ON_FILE =
  "No customer email address is recorded. Add or update the customer's email address before sending this notification.";

/** Short form for a tight space (a button title, a table cell). */
export const NO_EMAIL_SHORT = 'No email on file';
