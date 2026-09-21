import { Logger } from '@nestjs/common';
import {
  NotificationChannelName,
  NotificationProvider,
  SendNotificationInput,
  SendNotificationResult,
  VerifyProviderResult,
} from './notification-provider.interface';
import { UNSUPPORTED_CHANNEL_REASON } from '../notification-messages';

/**
 * CR-2026-099 — SMTP email provider.
 *
 * Any mailbox with SMTP credentials works (Microsoft 365, Google Workspace, a
 * relay, an ISP) — a delivery service, not a platform dependency. The transport
 * is INJECTED (created in the module factory) so this class stays pure and
 * unit-testable.
 *
 * CR-2026-106 — honours the server's own verdict: a recipient the server REJECTED
 * is a failure even when a message id came back; `verify()` proves the transport
 * (connection + authentication) so a wrong port or password is found in seconds.
 */

export interface SmtpSendConfig {
  /** From header, e.g. "Bert's Service Centre <service@berts.example>". */
  from: string;
}

/** Minimal slice of the nodemailer transport we use. */
export interface MailTransport {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[]; response?: string }>;
  verify?(): Promise<unknown>;
}

export class SmtpNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger(SmtpNotificationProvider.name);

  constructor(
    private readonly config: SmtpSendConfig,
    private readonly transport: MailTransport,
  ) {}

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    if (input.channel !== 'EMAIL') {
      return { success: false, failureReason: 'SMTP provider handles EMAIL only' };
    }
    const body = input.body ?? '';
    if (!body.trim()) {
      return { success: false, failureReason: 'Empty email body' };
    }
    try {
      const info = await this.transport.sendMail({
        from: this.config.from,
        to: input.recipient,
        subject: input.subject ?? "Message from Bert's Service Centre",
        text: body,
      });
      const accepted = (info.accepted ?? []).map(String);
      const rejected = (info.rejected ?? []).map(String);
      if (rejected.length > 0 && accepted.length === 0) {
        return {
          success: false,
          providerReference: info.messageId,
          accepted,
          rejected,
          response: info.response,
          failureReason: `Recipient rejected by the mail server${info.response ? `: ${info.response}` : ''}`,
        };
      }
      return { success: true, providerReference: info.messageId, accepted, rejected, response: info.response };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : 'SMTP send failed';
      // Never log message content or full recipient at error level.
      this.logger.error(`SMTP send failed (${input.templateKey}): ${failureReason}`);
      return { success: false, failureReason };
    }
  }

  async verify(channel: NotificationChannelName): Promise<VerifyProviderResult> {
    if (channel !== 'EMAIL') return { ok: false, detail: 'SMTP provider handles EMAIL only' };
    if (!this.transport.verify) return { ok: true, detail: 'transport does not support verification; a test send will prove it' };
    try {
      await this.transport.verify();
      return { ok: true, detail: 'connected and authenticated' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'SMTP verification failed' };
    }
  }
}

/**
 * CR-2026-112 — the channel router for an email-only release.
 *
 * Email goes to the configured email provider. Anything else is refused HERE,
 * with a reason, rather than quietly succeeding against a stub: a message this
 * deployment cannot deliver must never be recorded as sent (directive §9).
 * The class keeps its routing shape so a future SMS provider is a constructor
 * argument, not a rewrite.
 */
export class ChannelRouterProvider implements NotificationProvider {
  static readonly UNSUPPORTED_CHANNEL_REASON = UNSUPPORTED_CHANNEL_REASON;

  constructor(private readonly email: NotificationProvider) {}

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    if (input.channel !== 'EMAIL') {
      return { success: false, failureReason: ChannelRouterProvider.UNSUPPORTED_CHANNEL_REASON };
    }
    return this.email.send(input);
  }

  async verify(channel: NotificationChannelName): Promise<VerifyProviderResult> {
    if (channel !== 'EMAIL') {
      return { ok: false, detail: ChannelRouterProvider.UNSUPPORTED_CHANNEL_REASON };
    }
    if (!this.email.verify) return { ok: false, detail: 'provider cannot verify its transport' };
    return this.email.verify(channel);
  }
}
