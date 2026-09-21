import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { isFeatureOn, type RuleReader } from '../feature-flags';
import { FEATURES, FEATURE_DEFAULTS, featureValueIsOn } from '../../constants/features';
import { FeatureFlagGuard } from '../../guards/feature-flag.guard';
import { FEATURE_KEY } from '../../decorators/require-feature.decorator';

/**
 * CR-2026-116 — the Booking Simulator is a switch the business owns.
 *
 * The thing worth testing is not that a boolean reads back. It is that "off"
 * means the tool is actually gone: hiding a menu item while the endpoints keep
 * answering would make the switch a decoration.
 */

/** A rule table with whatever rows a test needs, and nothing else. */
function rules(rows: Record<string, unknown>): RuleReader {
  return {
    businessRuleConfig: {
      findFirst: async ({ where }) =>
        where.ruleKey in rows ? { valueJson: rows[where.ruleKey] } : null,
    },
  };
}

describe('reading the switch', () => {
  it('is on when a manager has set it on', async () => {
    expect(await isFeatureOn(rules({ booking_simulator_enabled: true }), FEATURES.BOOKING_SIMULATOR)).toBe(true);
  });

  it('is off when a manager has set it off', async () => {
    expect(await isFeatureOn(rules({ booking_simulator_enabled: false }), FEATURES.BOOKING_SIMULATOR)).toBe(false);
  });

  it('is ON when the deployment has no row yet', async () => {
    // The migration that seeds the row may not have run. Introducing a switch
    // must never be the thing that removes a tool managers already use.
    expect(await isFeatureOn(rules({}), FEATURES.BOOKING_SIMULATOR)).toBe(true);
    expect(FEATURE_DEFAULTS.booking_simulator_enabled).toBe(true);
  });

  it('treats a value nobody could have chosen through Settings as off', async () => {
    // The toggle stores a real boolean. A string, a number or null is not a
    // decision — and a testing tool is the wrong place to guess generously.
    for (const junk of ['true', 'yes', 1, null, {}]) {
      expect(featureValueIsOn(junk)).toBe(false);
    }
  });

  it('reads only the rule that is currently in force', async () => {
    // BusinessRuleConfig is versioned: superseded rows carry an effectiveTo.
    let asked: unknown;
    const reader: RuleReader = {
      businessRuleConfig: {
        findFirst: async (args) => {
          asked = args.where;
          return { valueJson: true };
        },
      },
    };
    await isFeatureOn(reader, FEATURES.BOOKING_SIMULATOR);
    expect(asked).toEqual({ ruleKey: 'booking_simulator_enabled', effectiveTo: null });
  });
});

describe('the guard on the controller', () => {
  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as never;

  function guardWith(required: string[] | undefined, rows: Record<string, unknown>) {
    const reflector = { getAllAndOverride: (key: string) => (key === FEATURE_KEY ? required : undefined) };
    return new FeatureFlagGuard(reflector as never, rules(rows) as never);
  }

  it('lets the request through when the feature is on', async () => {
    await expect(
      guardWith([FEATURES.BOOKING_SIMULATOR], { booking_simulator_enabled: true }).canActivate(context),
    ).resolves.toBe(true);
  });

  it('refuses when it is off, naming the switch and where to find it', async () => {
    const guard = guardWith([FEATURES.BOOKING_SIMULATOR], { booking_simulator_enabled: false });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    try {
      await guard.canActivate(context);
    } catch (e) {
      const body = (e as ForbiddenException).getResponse() as { code: string; feature: string; message: string };
      expect(body.code).toBe('FEATURE_DISABLED');
      expect(body.feature).toBe('booking_simulator_enabled');
      // Not "Forbidden" — that sends a manager hunting for a permissions
      // problem that does not exist.
      expect(body.message).toMatch(/switched off/i);
      expect(body.message).toMatch(/Settings/);
    }
  });

  it('does not interfere with routes that declare no feature', async () => {
    await expect(guardWith(undefined, {}).canActivate(context)).resolves.toBe(true);
    await expect(guardWith([], {}).canActivate(context)).resolves.toBe(true);
  });
});
