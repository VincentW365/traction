export interface SendNotificationInput {
  channel: 'SMS' | 'EMAIL';
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
  verify?(channel: 'SMS' | 'EMAIL'): Promise<VerifyProviderResult>;
}

export const NOTIFICATION_PROVIDER = 'NOTIFICATION_PROVIDER';

// CR-2026-096 — what the deployment can actually deliver, resolved once from env
// in the module factory. Screens never see provider names — only capability flags.
export interface NotificationCapabilities {
  /** A real SMS provider is configured (messages actually reach phones). */
  smsConfigured: boolean;
  /** A real email provider is configured (none exists yet — stub only). */
  emailConfigured: boolean;
  /** TEST redirects customer sends to the test recipients; LIVE sends for real. */
  mode: 'TEST' | 'LIVE';
  testSmsTo?: string;
  testEmailTo?: string;
  /** CR-2026-106 — presence-safe transport facts for the verification screen (never the password). */
  emailTransport?: { host: string; port: number; secure: boolean; from: string; user: string | null };
}

export const NOTIFICATION_CAPABILITIES = 'NOTIFICATION_CAPABILITIES';
