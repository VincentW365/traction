import { Global, Module } from '@nestjs/common';
import twilio from 'twilio';
import * as nodemailer from 'nodemailer';
import { validateEnv } from '@bsop/config';
import {
  ChannelRouterProvider,
  MailTransport,
  SmtpNotificationProvider,
} from './providers/smtp.provider';
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

  // SMS side (CR-2026-033)
  let smsProvider: NotificationProvider = new StubNotificationProvider();
  if (env.NOTIFICATION_PROVIDER === 'twilio') {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_MESSAGING_SERVICE_SID } = env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID)) {
      throw new Error(
        'NOTIFICATION_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID',
      );
    }
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) as unknown as TwilioMessageClient;
    smsProvider = new TwilioNotificationProvider(
      { fromNumber: TWILIO_FROM_NUMBER, messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID },
      client,
      new StubNotificationProvider(), // never reached — the router owns EMAIL
    );
  }

  // Email side (CR-2026-099) — any SMTP mailbox; the transport is confined here.
  let emailProvider: NotificationProvider = new StubNotificationProvider();
  if (env.EMAIL_PROVIDER === 'smtp') {
    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = env;
    if (!SMTP_HOST || !SMTP_FROM) {
      throw new Error('EMAIL_PROVIDER=smtp requires SMTP_HOST and SMTP_FROM (SMTP_USER/SMTP_PASS as your server needs)');
    }
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT ?? (SMTP_SECURE ? 465 : 587),
      secure: SMTP_SECURE,
      ...(SMTP_USER ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
    }) as unknown as MailTransport;
    emailProvider = new SmtpNotificationProvider({ from: SMTP_FROM }, transport);
  }

  return new ChannelRouterProvider(smsProvider, emailProvider);
}

/**
 * CR-2026-096 — capability flags resolved once from env. Frontend screens see only
 * these flags, never provider names or credentials.
 */
function notificationCapabilitiesFactory(): NotificationCapabilities {
  const env = validateEnv();
  return {
    smsConfigured: env.NOTIFICATION_PROVIDER === 'twilio',
    // CR-2026-099 — real email via any SMTP mailbox (EMAIL_PROVIDER=smtp).
    emailConfigured: env.EMAIL_PROVIDER === 'smtp',
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
