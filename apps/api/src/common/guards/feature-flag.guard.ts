import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FEATURE_KEY } from '../decorators/require-feature.decorator';
import { FEATURE_OFF_MESSAGE, type FeatureKey } from '../constants/features';
import { isFeatureOn } from '../helpers/feature-flags';

/**
 * CR-2026-116 — refuses a route whose feature is switched off.
 *
 * Why this exists at all, rather than just hiding the menu item: a screen the
 * navigation no longer shows is still a screen anyone can reach by typing the
 * address, and its endpoints would answer exactly as before. "Off" would then
 * mean "harder to find", which is not what a manager reading a switch labelled
 * On/Off is being told. The switch has to be enforced where the data is served.
 *
 * Ordering matters. This is listed AFTER JwtAuthGuard and RbacGuard, so someone
 * who is not signed in is told that, and never learns which of the business's
 * internal tools happen to be switched off.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<FeatureKey[] | undefined>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    for (const feature of required) {
      if (!(await isFeatureOn(this.prisma, feature))) {
        throw new ForbiddenException({
          code: 'FEATURE_DISABLED',
          feature,
          message: FEATURE_OFF_MESSAGE[feature],
        });
      }
    }

    return true;
  }
}
