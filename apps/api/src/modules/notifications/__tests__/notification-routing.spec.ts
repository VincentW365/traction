import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  LIVE_SENDING_RULE,
  TEST_RECIPIENT_RULE,
  NotificationRoutingService,
} from '../notification-routing.service';
import type { NotificationCapabilities } from '../providers/notification-provider.interface';

/**
 * CR-2026-117 — coming out of test routing without the deployment holder.
 *
 * The thing worth testing is the boundary: the ROUTING decision moved into
 * Settings, the MAILBOX did not. A manager can decide who the system writes to;
 * nobody can put an SMTP password in a database row.
 */

function rules(rows: Record<string, unknown>) {
  return {
    businessRuleConfig: {
      findFirst: vi.fn(async (args: { where: { ruleKey: string } }) =>
        args.where.ruleKey in rows ? { valueJson: rows[args.where.ruleKey] } : null,
      ),
    },
  };
}

const WIRED: NotificationCapabilities = { emailConfigured: true, mode: 'TEST', testEmailTo: 'env@bert.local' };
const NO_MAILBOX: NotificationCapabilities = { emailConfigured: false, mode: 'TEST' };

describe('the setting decides, the environment is the fallback', () => {
  it('sends live when a manager has turned it on, whatever the environment said', async () => {
    const svc = new NotificationRoutingService(rules({ [LIVE_SENDING_RULE]: true }) as never);
    const r = await svc.resolve(WIRED); // env says TEST
    expect(r.mode).toBe('LIVE');
    expect(r.source).toBe('SETTING');
  });

  it('holds at the test address when a manager has turned it off, whatever the environment said', async () => {
    // The switch has to work in BOTH directions, or it is not a switch — a
    // manager who sees a problem must be able to stop the sending themselves.
    const svc = new NotificationRoutingService(rules({ [LIVE_SENDING_RULE]: false }) as never);
    const r = await svc.resolve({ ...WIRED, mode: 'LIVE' });
    expect(r.mode).toBe('TEST');
  });

  it('falls back to the environment when no row exists', async () => {
    // A deployment that has not run the migration must behave exactly as it did.
    const svc = new NotificationRoutingService(rules({}) as never);
    expect((await svc.resolve({ ...WIRED, mode: 'LIVE' })).mode).toBe('LIVE');
    expect((await svc.resolve({ ...WIRED, mode: 'TEST' })).mode).toBe('TEST');
    expect((await svc.resolve(WIRED)).source).toBe('ENVIRONMENT');
  });

  it('treats anything that is not a true boolean as not-live', async () => {
    for (const junk of ['true', 'LIVE', 1, null, {}]) {
      const svc = new NotificationRoutingService(rules({ [LIVE_SENDING_RULE]: junk }) as never);
      expect((await svc.resolve(WIRED)).mode).toBe('TEST');
    }
  });
});

describe('the test recipient', () => {
  it('prefers the one set in Settings', async () => {
    const svc = new NotificationRoutingService(
      rules({ [TEST_RECIPIENT_RULE]: 'manager@bert.local' }) as never,
    );
    expect((await svc.resolve(WIRED)).testEmailTo).toBe('manager@bert.local');
  });

  it('falls back to the environment when the setting is blank', async () => {
    // Empty means "not answered here", never "send to nowhere".
    for (const blank of ['', '   ']) {
      const svc = new NotificationRoutingService(rules({ [TEST_RECIPIENT_RULE]: blank }) as never);
      expect((await svc.resolve(WIRED)).testEmailTo).toBe('env@bert.local');
    }
  });

  it('trims it, because a trailing space in an address is a bounced message', async () => {
    const svc = new NotificationRoutingService(rules({ [TEST_RECIPIENT_RULE]: ' m@bert.local ' }) as never);
    expect((await svc.resolve(WIRED)).testEmailTo).toBe('m@bert.local');
  });
});

describe('what the setting cannot do', () => {
  it('cannot conjure a mailbox — live with no provider is still only simulated', async () => {
    const svc = new NotificationRoutingService(rules({ [LIVE_SENDING_RULE]: true }) as never);
    const r = await svc.resolve(NO_MAILBOX);
    expect(r.mode).toBe('LIVE');
    // The transport is env-only by design, so the honest answer is "nothing was
    // actually delivered" rather than a switch that claims otherwise.
    expect(r.emailConfigured).toBe(false);
  });

  it('explains the mailbox gap in words a manager can act on', () => {
    const msg = NotificationRoutingService.mailboxMissingMessage();
    expect(msg).toMatch(/mailbox/i);
    expect(msg).not.toMatch(/SMTP_|EMAIL_PROVIDER|env/); // not a variable name to hunt for
    expect(msg).toMatch(/deployment/i); // but it does say whose job it is
  });
});

describe('the guard on turning it on', () => {
  // Mirrors ConfigService.updateRule: a switch that reads ON while every message
  // is still simulated would be discovered by a customer who was never told.
  function guard(emailConfigured: boolean) {
    return () => {
      if (!emailConfigured) {
        throw new BadRequestException({
          code: 'EMAIL_MAILBOX_NOT_CONFIGURED',
          message: NotificationRoutingService.mailboxMissingMessage(),
        });
      }
    };
  }

  it('refuses without a mailbox', () => {
    expect(guard(false)).toThrow(BadRequestException);
  });

  it('allows it once a mailbox is wired', () => {
    expect(guard(true)).not.toThrow();
  });
});
