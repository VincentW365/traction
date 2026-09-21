import { SetMetadata } from '@nestjs/common';
import type { FeatureKey } from '../constants/features';

export const FEATURE_KEY = 'required_feature';

/**
 * CR-2026-116 — this route only exists while the named feature is switched on.
 *
 * Deliberately shaped like `@RequirePermission` so the two read the same way on
 * a controller, and enforced by `FeatureFlagGuard`.
 */
export const RequireFeature = (...features: FeatureKey[]) => SetMetadata(FEATURE_KEY, features);
