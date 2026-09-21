/**
 * CR-2026-112 — the operational sentences a person reads when a customer email
 * cannot go out.
 *
 * They live in one file, with no imports, because both the composer service and
 * the automatic-flow service need them and the two import each other. More
 * importantly: what the front desk is told must not drift between the screen
 * that composes a message and the panel that sends one.
 */

/** No email address on file. The exact wording required by the directive (§8). */
export const NO_EMAIL_ON_FILE =
  "No customer email address is recorded. Add or update the customer's email address before sending this notification.";

/** A caller asked for a channel this release cannot deliver on. */
export const EMAIL_ONLY_RELEASE =
  'This release sends customer notifications by email only.';

/** What the provider layer reports when a non-email send is refused. */
export const UNSUPPORTED_CHANNEL_REASON =
  `${EMAIL_ONLY_RELEASE} SMS is not configured and no message was sent.`;
