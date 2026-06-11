import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ROLE_PERMISSIONS } from '../../common/constants/permissions';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { DEV_LOGIN_PROFILES, findDevProfile, type DevLoginProfile } from './dev-login-profiles';

/** Minimal user shape needed to mint a session. */
interface TokenUser {
  id: string;
  email: string | null;
  fullName: string;
  roleCode: string;
  siteId: string | null;
}

@Injectable()
export class AuthService {
  private readonly jwtSecret = process.env.JWT_SECRET!;
  private readonly accessExpiry = process.env.JWT_ACCESS_EXPIRY || '15m';
  private readonly refreshExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * Issue normal access + refresh tokens for a user (shared by login + dev-login).
   * Behaviour is identical to the previous inline signing in login().
   */
  private issueTokensForUser(user: TokenUser) {
    const permissions = ROLE_PERMISSIONS[user.roleCode] ?? [];
    const payload: JwtPayload = {
      sub: user.id,
      role: user.roleCode,
      siteId: user.siteId,
      permissions,
    };
    const accessToken = jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.accessExpiry as jwt.SignOptions['expiresIn'],
    });
    const refreshToken = jwt.sign(
      { sub: user.id, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: this.refreshExpiry as jwt.SignOptions['expiresIn'] },
    );
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        roleCode: user.roleCode,
        siteId: user.siteId,
      },
    };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.userAccount.findFirst({
      where: { email, status: 'ACTIVE' },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokensForUser(user);
  }

  // --- CR-2026-022: dev-only one-click role login (gated; never in production) ---

  /** Effective ONLY when ALLOW_DEV_LOGIN=true AND NODE_ENV !== 'production'. */
  private devLoginEnabled(): boolean {
    return process.env.ALLOW_DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production';
  }

  private async resolveDevUser(profile: DevLoginProfile): Promise<TokenUser | null> {
    if (profile.reuseExistingAdmin) {
      // Reuse the EXISTING admin — prefer the canonical email, else the first ACTIVE ADMIN.
      const byEmail = await this.prisma.userAccount.findFirst({
        where: { email: profile.email, roleCode: 'ADMIN', status: 'ACTIVE' },
      });
      if (byEmail) return byEmail;
      return this.prisma.userAccount.findFirst({
        where: { roleCode: 'ADMIN', status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      });
    }
    return this.prisma.userAccount.findFirst({
      where: { email: profile.email, roleCode: profile.role, status: 'ACTIVE' },
    });
  }

  /** Dev-only: list the role profiles + whether each mapped user exists yet. Gated. */
  async listDevProfiles() {
    if (!this.devLoginEnabled()) {
      throw new ForbiddenException('Dev login is disabled');
    }
    const profiles = [];
    for (const p of DEV_LOGIN_PROFILES) {
      const user = await this.resolveDevUser(p);
      profiles.push({
        role: p.role,
        email: user?.email ?? p.email,
        displayName: user?.fullName ?? p.displayName,
        group: p.group,
        permissionsSummary: p.permissionsSummary,
        available: !!user,
      });
    }
    return {
      enabled: true,
      warning: 'Development/Test Login Only — Disabled in Production.',
      profiles,
    };
  }

  /** Dev-only: sign in as a role by minting a normal session for the mapped user. Gated. */
  async devLogin(role: string) {
    if (!this.devLoginEnabled()) {
      throw new ForbiddenException('Dev login is disabled');
    }
    const profile = findDevProfile(role);
    if (!profile) {
      throw new BadRequestException(`Unsupported dev-login role: ${role}`);
    }
    const user = await this.resolveDevUser(profile);
    if (!user) {
      throw new NotFoundException(
        `Dev user for ${role} is not seeded yet (${profile.email}). Run scripts/seed-dev-users.ts (CR-2026-022 D-b).`,
      );
    }
    await this.audit.log({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.DEV_LOGIN,
      entityType: 'UserAccount',
      entityId: user.id,
      afterJson: { role: user.roleCode, email: user.email },
      reasonCode: 'DEV_LOGIN',
    });
    return this.issueTokensForUser(user);
  }

  async refresh(refreshToken: string) {
    try {
      const decoded = jwt.verify(refreshToken, this.jwtSecret) as {
        sub: string;
        type: string;
      };

      if (decoded.type !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await this.prisma.userAccount.findUnique({
        where: { id: decoded.sub },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('User not found or inactive');
      }

      const permissions = ROLE_PERMISSIONS[user.roleCode] ?? [];

      const payload: JwtPayload = {
        sub: user.id,
        role: user.roleCode,
        siteId: user.siteId,
        permissions,
      };

      const accessToken = jwt.sign(payload, this.jwtSecret, {
        expiresIn: this.accessExpiry as jwt.SignOptions['expiresIn'],
      });

      return { accessToken };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async getProfile(userId: string) {
    const user = await this.prisma.userAccount.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        roleCode: true,
        siteId: true,
        status: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }
}
