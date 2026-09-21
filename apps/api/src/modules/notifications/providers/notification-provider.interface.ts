/**
 * CR-2026-112 — Customer Email Notifications.
 *
 * The adapter stays CHANNEL-SHAPED on purpose: `channel` is still part of every
 * send, and the router still dispatches on it. What changed is that EMAIL is the
 * only channel this release can deliver on. A request for any other channel is
 * REFUSED by the router with a reason — never accepted by a stub and recorded as
 * sent. Adding SMS later means writing one provider and registering it in the
 * module factory; nothing above this line has to change.
 */

/** Channels the domain knows about. Only EMAIL is deliverable in this release. */
export type NotificationChannelName = 'EMAIL' | 'SMS';

export interface SendNotificationInput {
  channel: NotificationChannelName;
  recipient: string;
  templateKey: string;
  templateData: Record<string, unknown>;
  // CR-2026-096 — pre-rendered content from the unified composer pipeline. When
  // present the provider sends this exact text; templateKey/templateData remain
  // the legacy rendering path for older flows.
  body?: string;
  subject?: string;
}

export interface SendNotificationResult {
  success: boolean;
  providerReference?: string;
  failureReason?: string;
  // CR-2026-106 — the provider's own account of what happened, so "accepted by
  // the mail server" can be told apart from "delivered" and a rejected recipient
  // is a FAILURE, not a success with a message id.
  accepted?: string[];
  rejected?: string[];
  response?: string;
}

/** CR-2026-106 — result of asking the provider to prove its transport works. */
export interface VerifyProviderResult {
  ok: boolean;
  detail: string;
}

export interface NotificationProvider {
  send(input: SendNotificationInput): Promise<SendNotificationResult>;
  /** Optional: prove the outbound transport (connection + authentication) works. */
  verify?(channel: NotificationChannelName): Promise<VerifyProviderResult>;
}

export const NOTIFICATION_PROVIDER = 'NOTIFICATION_PROVIDER';

// CR-2026-096 — what the deployment can actually deliver, resolved once from env
// in the module factory. Screens never see provider names — only capability flags.
// CR-2026-112 — the SMS flags are gone with the SMS provider: a screen cannot
// offer, warn about, or even mention a channel this release does not have.
export interface NotificationCapabilities {
  /** A real email provider is configured (messages actually reach mailboxes). */
  emailConfigured: boolean;
  /** TEST redirects customer sends to the test recipient; LIVE sends for real. */
  mode: 'TEST' | 'LIVE';
  testEmailTo?: string;
  /** CR-2026-106 — presence-safe transport facts for the verification screen (never the password). */
  emailTransport?: { host: string; port: number; secure: boolean; from: string; user: string | null };
}

export const NOTIFICATION_CAPABILITIES = 'NOTIFICATION_CAPABILITIES';
