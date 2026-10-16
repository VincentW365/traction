import { FEATURE_DEFAULTS, featureValueIsOn, type FeatureKey } from '../constants/features';

/**
 * CR-2026-116 — the one reading of a feature switch.
 *
 * Both the guard on the controller and the services that need the same answer
 * outside a request pipeline call this, so "is this feature on?" cannot be
 * answered two different ways by two pieces of the same feature.
 *
 * Typed against the shape it actually uses rather than PrismaService itself, so
 * the rule can be tested without a database.
 */
export interface RuleReader {
  businessRuleConfig: {
    findFirst(args: {
      where: { ruleKey: string; effectiveTo: null };
      select: { valueJson: true };
    }): Promise<{ valueJson: unknown } | null>;
  };
}

/**
 * The rule is read unscoped by site, matching every other switch in the
 * platform (`booking_enabled`, `appointment_reminder_enabled`): the pilot is
 * single-site, and a half-site-aware flag would be a worse lie than an honestly
 * global one.
 *
 * No row at all means the deployment predates the switch, and a feature that
 * existed yesterday must not vanish because a migration has not run: the
 * default is ON unless `FEATURE_DEFAULTS` says otherwise.
 */
export async function isFeatureOn(prisma: RuleReader, feature: FeatureKey): Promise<boolean> {
  const row = await prisma.businessRuleConfig.findFirst({
    where: { ruleKey: feature, effectiveTo: null },
    select: { valueJson: true },
  });
  return row ? featureValueIsOn(row.valueJson) : (FEATURE_DEFAULTS[feature] ?? true);
}
