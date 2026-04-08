import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { JwtPayload } from '../decorators/current-user.decorator';

@Injectable()
export class SiteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    if (!user) {
      return false;
    }

    // ADMIN can access any site
    if (user.role === 'ADMIN') {
      return true;
    }

    // Extract siteId from request (params, query, or body)
    const siteId =
      request.params?.siteId ??
      request.query?.siteId ??
      request.body?.siteId;

    // If no siteId in request, allow (endpoint may not be site-scoped)
    if (!siteId) {
      return true;
    }

    // User must belong to the requested site
    if (user.siteId !== siteId) {
      throw new ForbiddenException(
        'Access denied: you do not belong to the requested site',
      );
    }

    return true;
  }
}
