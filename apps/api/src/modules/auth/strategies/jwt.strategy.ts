import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'fallback-dev-secret-do-not-use-in-production',
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    return {
      sub: payload.sub,
      role: payload.role,
      siteId: payload.siteId,
      permissions: payload.permissions,
    };
  }
}
