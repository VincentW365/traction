import { Global, Module } from '@nestjs/common';
import twilio from 'twilio';
import { validateEnv } from '@bsop/config';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { StubNotificationProvider } from './providers/stub.provider';
import { TwilioNotificationProvider, TwilioMessageClient } from './providers/twilio.provider';
import { NOTIFICATION_PROVIDER, NotificationProvider } from './providers/notification-provider.interface';

/**
 * CR-2026-033 — provider selection. Default is the stub (dev/test/CI unchanged);
 * NOTIFICATION_PROVIDER=twilio wires the real SMS provider (EMAIL falls back to the
 * stub). The Twilio SDK import is confined to this factory.
 */
function notificationProviderFactory(): NotificationProvider {
  const env = validateEnv();
  if (env.NOTIFICATION_PROVIDER !== 'twilio') {
    return new StubNotificationProvider();
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_MESSAGING_SERVICE_SID } = env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID)) {
    throw new Error(
      'NOTIFICATION_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID',
    );
  }

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) as unknown as TwilioMessageClient;
  return new TwilioNotificationProvider(
    { fromNumber: TWILIO_FROM_NUMBER, messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID },
    client,
    new StubNotificationProvider(),
  );
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    { provide: NOTIFICATION_PROVIDER, useFactory: notificationProviderFactory },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
