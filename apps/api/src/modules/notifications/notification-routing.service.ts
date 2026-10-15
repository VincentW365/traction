import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationCapabilities } from './providers/notification-provider.interface';

/**
 * CR-2026-117 — where customer email actually goes, decided at send time.
 *
 * Until now this was frozen at boot from `NOTIFICATION_MODE`, so coming out of
 * test routing meant an environment variable change and a redeploy — which is
 * to say it meant whoever holds the deployment credentials, every time. That is
 * the wrong gate. Test routing is an operational decision about customers, not
 * a piece of infrastructure, and it belongs with the people who answer to those
 * customers.
 *
 * WHAT DID NOT MOVE, and must not: the mailbox itself. `EMAIL_PROVIDER` and the
 * SMTP host, user, password and from-address stay in deployment config. A
 * mailbox password in a `BusinessRuleConfig` row is readable by every account
 * with CONFIG_VIEW, is copied verbatim into the audit log's before/after values
 * on any edit, and is in every database backup from then on. CLAUDE.md §10 puts
 * provider credentials behind the env boundary and that is the right call.
 *
 * So the split is: the owner wires the mailbox ONCE; after that, management
 * decides who it writes to, from Settings, with an audit trail.
 */

export const LIVE_SENDING_RULE = 'notifications_live_sending';
export const TEST_RECIPIENT_RULE = 'notifications_test_email_to';

export interface EffectiveRouting {
  mode: 'TEST' | 'LIVE';
  testEmailTo?: string;
  /** True when a real mailbox is wired — without it, LIVE still only simulates. */
  emailConfigured: boolean;
  /** Where the live/test decision came from, for the verification screen. */
  source: 'SETTING' | 'ENVIRONMENT';
}

@Injectable()
export class NotificationRoutingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The rule wins where it exists; the environment is the fallback.
   *
   * The fallback is not decoration. A deployment that has not run the migration
   * yet, or a fresh database mid-setup, has no row — and must keep behaving
   * exactly as it did rather than silently defaulting to one answer or the
   * other.
   */
  async resolve(caps: NotificationCapabilities): Promise<EffectiveRouting> {
    const [liveRow, recipientRow] = await Promise.all([
      this.prisma.businessRuleConfig.findFirst({
        where: { ruleKey: LIVE_SENDING_RULE, effectiveTo: null },
        select: { valueJson: true },
      }),
      this.prisma.businessRuleConfig.findFirst({
        where: { ruleKey: TEST_RECIPIENT_RULE, effectiveTo: null },
        select: { valueJson: true },
      }),
    ]);

    const mode: 'TEST' | 'LIVE' = liveRow
      ? liveRow.valueJson === true
        ? 'LIVE'
        : 'TEST'
      : caps.mode;

    // An empty string in the setting means "not set here", not "send to nowhere".
    const configuredRecipient =
      typeof recipientRow?.valueJson === 'string' && recipientRow.valueJson.trim()
        ? recipientRow.valueJson.trim()
        : undefined;

    return {
      mode,
      testEmailTo: configuredRecipient ?? caps.testEmailTo,
      emailConfigured: caps.emailConfigured,
      source: liveRow ? 'SETTING' : 'ENVIRONMENT',
    };
  }

  /**
   * Is a real mailbox wired? Turning live sending on without one would be a
   * switch that reads ON and still delivers nothing, which is worse than a
   * switch that refuses.
   */
  static mailboxMissingMessage(): string {
    return (
      'Live sending cannot be turned on until a mailbox is connected to this installation. ' +
      'Until then every message is recorded as simulated and nothing reaches anyone, so the switch ' +
      'would be telling you something untrue. Ask whoever manages the deployment to connect the ' +
      'mailbox; after that this switch is the only thing that needs to change.'
    );
  }
}
