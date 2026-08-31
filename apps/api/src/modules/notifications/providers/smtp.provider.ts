import { Logger } from '@nestjs/common';
import {
  NotificationProvider,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-provider.interface';

/**
 * CR-2026-099 — SMTP email provider.
 *
 * Any mailbox with SMTP credentials works (Microsoft 365, Google Workspace, a
 * relay, an ISP) — a delivery service, not a platform dependency. The transport
 * is INJECTED (created in the module factory, same isolation pattern as the
 * Twilio client) so this class stays pure and unit-testable.
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
  }): Promise<{ messageId?: string }>;
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
      return { success: true, providerReference: info.messageId };
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : 'SMTP send failed';
      // Never log message content or full recipient at error level.
      this.logger.error(`SMTP send failed (${input.templateKey}): ${failureReason}`);
      return { success: false, failureReason };
    }
  }
}

/**
 * Routes each channel to its configured provider. Twilio no longer needs to
 * know anything about email, and email knows nothing about SMS.
 */
export class ChannelRouterProvider implements NotificationProvider {
  constructor(
    private readonly sms: NotificationProvider,
    private readonly email: NotificationProvider,
  ) {}

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    return input.channel === 'EMAIL' ? this.email.send(input) : this.sms.send(input);
  }
}
