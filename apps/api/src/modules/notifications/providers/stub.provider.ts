import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationProvider,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-provider.interface';

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
