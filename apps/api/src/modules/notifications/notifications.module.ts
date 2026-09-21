import { Global, Module } from '@nestjs/common';
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
import { TestRecordResolver } from './test-record.resolver';
import { StubNotificationProvider } from './providers/stub.provider';
import { NotificationTemplateStore } from './templates/template-store.service';
import {
  NOTIFICATION_CAPABILITIES,
  NOTIFICATION_PROVIDER,
  NotificationCapabilities,
  NotificationProvider,
} from './providers/notification-provider.interface';

/**
 * CR-2026-112 — provider selection for an email-only release.
 *
 * Email is the ONE customer channel. `EMAIL_PROVIDER=smtp` wires a real mailbox
 * (CR-2026-099); anything else leaves the stub in place, which records messages
 * as simulated rather than pretending they were delivered. No SMS credentials
 * are read, required, or validated anywhere in this factory — an unconfigured
 * SMS provider cannot affect email, because there is no SMS provider.
 *
 * Adding SMS in a later phase: write the provider, construct it here, and pass
 * it to ChannelRouterProvider. Nothing else in the module changes.
 */
function notificationProviderFactory(): NotificationProvider {
  const env = validateEnv();

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
      // CR-2026-106 — a wrong port/host must fail in seconds, not hold the request
      // for the library defaults (up to two minutes) while the screen says "sending".
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    }) as unknown as MailTransport;
    emailProvider = new SmtpNotificationProvider({ from: SMTP_FROM }, transport);
  }

  return new ChannelRouterProvider(emailProvider);
}

/**
 * CR-2026-096 — capability flags resolved once from env. Frontend screens see only
 * these flags, never provider names or credentials.
 */
function notificationCapabilitiesFactory(): NotificationCapabilities {
  const env = validateEnv();
  return {
    // CR-2026-099 — real email via any SMTP mailbox (EMAIL_PROVIDER=smtp).
    emailConfigured: env.EMAIL_PROVIDER === 'smtp',
    mode: env.NOTIFICATION_MODE,
    testEmailTo: env.NOTIFICATION_TEST_EMAIL_TO,
    // CR-2026-106 — presence-safe transport facts for the verification screen.
    ...(env.EMAIL_PROVIDER === 'smtp' && env.SMTP_HOST && env.SMTP_FROM
      ? {
          emailTransport: {
            host: env.SMTP_HOST,
            port: env.SMTP_PORT ?? (env.SMTP_SECURE ? 465 : 587),
            secure: env.SMTP_SECURE,
            from: env.SMTP_FROM,
            user: env.SMTP_USER ? env.SMTP_USER.replace(/^(.{2}).*(@.*)$/, '$1…$2') : null,
          },
        }
      : {}),
  };
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsCronService,
    CustomerNotificationsService,
    // CR-2026-112 — the one place customer-facing wording is resolved from.
    NotificationTemplateStore,
    // CR-2026-108 Stage 1 — decides, per record, whether a message is about a
    // test run and must be captured rather than transmitted.
    TestRecordResolver,
    { provide: NOTIFICATION_PROVIDER, useFactory: notificationProviderFactory },
    { provide: NOTIFICATION_CAPABILITIES, useFactory: notificationCapabilitiesFactory },
  ],
  exports: [NotificationsService, CustomerNotificationsService, TestRecordResolver, NotificationTemplateStore],
})
export class NotificationsModule {}
