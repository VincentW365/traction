/**
 * CR-2026-116 — features the business can switch off without a redeployment.
 *
 * A feature flag is not a permission. Permissions answer "may THIS PERSON do
 * it"; a flag answers "is the business running this at all". They are kept
 * apart because they fail differently: a permission failure means ask someone
 * else, a flag failure means nobody can, until a manager turns it back on.
 *
 * The value lives in `BusinessRuleConfig` like every other configurable rule,
 * so switching it is versioned and audited by the machinery that already exists
 * (`ConfigService.updateRule`) rather than by a mechanism of its own.
 */

export const FEATURES = {
  /**
   * Setup → Booking Simulator, and the UAT test-booking session it issues.
   * Off means the screen, its endpoints and new test sessions are all gone —
   * see `FeatureFlagGuard` for why hiding only the menu item would be a lie.
   */
  BOOKING_SIMULATOR: 'booking_simulator_enabled',
} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

/**
 * What the value is when the deployment has no row for the key.
 *
 * TRUE for the simulator, deliberately: this flag is being introduced over a
 * working feature, and an installation that has not yet run the migration must
 * behave exactly as it did yesterday. A default that silently removed a tool
 * managers already use would be a behaviour change disguised as a new setting.
 */
export const FEATURE_DEFAULTS: Record<FeatureKey, boolean> = {
  booking_simulator_enabled: true,
};

/**
 * What someone is told when they reach a feature that is switched off.
 *
 * It names the switch and where it lives. "Forbidden" would send a manager
 * hunting for a permissions problem that does not exist.
 */
export const FEATURE_OFF_MESSAGE: Record<FeatureKey, string> = {
  booking_simulator_enabled:
    'The Booking Simulator is switched off for this site. A manager can turn it back on under ' +
    'Settings → Booking & Scheduling → Testing tools.',
};

/**
 * Read a stored rule value as a switch.
 *
 * Strict: only a JSON `true` is on. The Settings toggle stores a real boolean,
 * so anything else in the column is a value nobody chose through the supported
 * path, and a testing tool is the wrong place to be generous about that.
 */
export function featureValueIsOn(valueJson: unknown): boolean {
  return valueJson === true;
}
