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
}

export interface NotificationProvider {
  send(input: SendNotificationInput): Promise<SendNotificationResult>;
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
}

export const NOTIFICATION_CAPABILITIES = 'NOTIFICATION_CAPABILITIES';
