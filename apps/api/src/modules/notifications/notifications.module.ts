import { Global, Module } from '@nestjs/common';
import twilio from 'twilio';
import { validateEnv } from '@bsop/config';
import { NotificationsService } from './notifications.service';
import { NotificationsCronService } from './notifications-cron.service';
import { NotificationsController } from './notifications.controller';
import { CustomerNotificationsService } from './customer-notifications.service';
import { StubNotificationProvider } from './providers/stub.provider';
import { TwilioNotificationProvider, TwilioMessageClient } from './providers/twilio.provider';
import {
  NOTIFICATION_CAPABILITIES,
  NOTIFICATION_PROVIDER,
  NotificationCapabilities,
  NotificationProvider,
} from './providers/notification-provider.interface';

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

/**
 * CR-2026-096 — capability flags resolved once from env. Frontend screens see only
 * these flags, never provider names or credentials.
 */
function notificationCapabilitiesFactory(): NotificationCapabilities {
  const env = validateEnv();
  return {
    smsConfigured: env.NOTIFICATION_PROVIDER === 'twilio',
    // No real email provider is wired yet (SendGrid/SMTP is a future CR) — email
    // sends are recorded but flagged `simulated` until one is configured.
    emailConfigured: false,
    mode: env.NOTIFICATION_MODE,
    testSmsTo: env.NOTIFICATION_TEST_SMS_TO,
    testEmailTo: env.NOTIFICATION_TEST_EMAIL_TO,
  };
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsCronService,
    CustomerNotificationsService,
    { provide: NOTIFICATION_PROVIDER, useFactory: notificationProviderFactory },
    { provide: NOTIFICATION_CAPABILITIES, useFactory: notificationCapabilitiesFactory },
  ],
  exports: [NotificationsService, CustomerNotificationsService],
})
export class NotificationsModule {}
