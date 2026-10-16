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
 *
 * CR-2026-121 — the one feature this introduced the switch for, the Booking
 * Simulator, has been removed now that its testing is complete, so the table is
 * empty. The mechanism stays (`@RequireFeature`, `FeatureFlagGuard`,
 * `isFeatureOn`, `useFeatureEnabled`): the next tool management wants to be
 * able to switch off adds one line here and one row to the Settings catalogue,
 * and the guard enforces it at the API, not just the menu.
 */

export const FEATURES = {} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

/**
 * What the value is when the deployment has no row for the key.
 *
 * A switch is always introduced over a working feature, and an installation
 * that has not yet run the migration must behave exactly as it did yesterday —
 * so the default for a key not listed here is ON (see `isFeatureOn`). List a
 * feature here only to default it OFF, which is the unusual case.
 */
export const FEATURE_DEFAULTS: Partial<Record<FeatureKey, boolean>> = {};

/**
 * What someone is told when they reach a feature that is switched off.
 *
 * It names the switch and where it lives. "Forbidden" would send a manager
 * hunting for a permissions problem that does not exist.
 */
export const FEATURE_OFF_MESSAGE: Partial<Record<FeatureKey, string>> = {};

/** The message for a switched-off feature that has no wording of its own. */
export const FEATURE_OFF_FALLBACK_MESSAGE =
  'This feature is switched off for this site. A manager can turn it back on under Settings.';

/**
 * Read a stored rule value as a switch.
 *
 * Strict: only a JSON `true` is on. The Settings toggle stores a real boolean,
 * so anything else in the column is a value nobody chose through the supported
 * path, and a switch is the wrong place to be generous about that.
 */
export function featureValueIsOn(valueJson: unknown): boolean {
  return valueJson === true;
}
