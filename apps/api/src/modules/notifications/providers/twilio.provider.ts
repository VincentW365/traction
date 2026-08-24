import { Logger } from '@nestjs/common';
import {
  NotificationProvider,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-provider.interface';
import { renderSmsBody } from '../templates/sms-templates';

/**
 * CR-2026-033 — Twilio SMS provider.
 *
 * Isolated behind the NotificationProvider adapter (CLAUDE.md §3). The Twilio SDK
 * client is INJECTED (created in the module factory) so this class stays pure and
 * unit-testable with a mock. SMS → Twilio; EMAIL → delegated to the stub/email
 * fallback (Twilio is SMS-only; real email is a future SendGrid CR).
 */
export interface TwilioSendConfig {
  fromNumber?: string;
  messagingServiceSid?: string;
}

/** Minimal slice of the Twilio client we use — keeps the class SDK-free for tests. */
export interface TwilioMessageClient {
  messages: {
    create(opts: { to: string; body: string; from?: string; messagingServiceSid?: string }): Promise<{ sid: string }>;
  };
}

/** Normalize a raw phone to E.164 for Jamaica (+1 876/658). Pure + tested. */
export function toE164Jamaica(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 7) return `+1876${digits}`;
  return `+${digits}`;
}

export class TwilioNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger(TwilioNotificationProvider.name);

  constructor(
    private readonly config: TwilioSendConfig,
    private readonly client: TwilioMessageClient,
    /** Fallback for non-SMS channels (EMAIL) — typically the StubNotificationProvider. */
    private readonly emailFallback: NotificationProvider,
  ) {}

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    if (input.channel !== 'SMS') {
      // Twilio handles SMS only; EMAIL stays on the existing path.
      return this.emailFallback.send(input);
    }

    try {
      // CR-2026-096 — the composer pipeline pre-renders the exact text (after any
      // staff edits); legacy flows still render from templateKey.
      const body = input.body ?? renderSmsBody(input.templateKey, input.templateData);
      const to = toE164Jamaica(input.recipient);
      const msg = await this.client.messages.create({
        to,
        body,
        ...(this.config.messagingServiceSid
          ? { messagingServiceSid: this.config.messagingServiceSid }
          : { from: this.config.fromNumber }),
      });
      return { success: true, providerReference: msg.sid };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : 'Twilio send failed';
      // Never log the message body or recipient at error level beyond the masked number.
      this.logger.error(`Twilio SMS failed (${input.templateKey}): ${failureReason}`);
      return { success: false, failureReason };
    }
  }
}
