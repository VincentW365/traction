import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationProvider,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-provider.interface';

/**
 * No email provider configured (EMAIL_PROVIDER=stub) — dev, CI, and any
 * deployment that has not had a mailbox wired up yet.
 *
 * It reports success so the workflow stays usable, but the caller marks the log
 * row `simulated: true` and every screen reads "Simulated — not delivered"
 * (CR-2026-106). Nothing here is ever presented to a person as a sent message.
 */
@Injectable()
export class StubNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger(StubNotificationProvider.name);

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    this.logger.warn(
      `[STUB] Would send ${input.channel} to ${input.recipient} (template: ${input.templateKey})`,
    );
    return {
      success: true,
      providerReference: `stub-${Date.now()}`,
    };
  }
}
