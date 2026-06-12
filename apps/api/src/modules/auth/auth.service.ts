import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ROLE_PERMISSIONS } from '../../common/constants/permissions';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { DEV_LOGIN_PROFILES, findDevProfile, type DevLoginProfile } from './dev-login-profiles';
import { SandboxContextService } from '../../common/sandbox/sandbox-context.service';
import { loadCleanupPlan, evaluateSafety, executeCleanup } from '../data-import/test-data/cleanup';

const DEV_SANDBOX_CONFIRM = 'CLEAN UP DEV SANDBOX';

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
    private sandbox: SandboxContextService,
  ) {}

  /** Sign an access token. `sandboxRunId` (CR-2026-023) is added ONLY for dev-login sessions. */
  private signAccessToken(user: TokenUser, sandboxRunId?: string): string {
    const permissions = ROLE_PERMISSIONS[user.roleCode] ?? [];
    const payload: JwtPayload = {
      sub: user.id,
      role: user.roleCode,
      siteId: user.siteId,
      permissions,
      ...(sandboxRunId ? { sandboxRunId } : {}),
    };
    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.accessExpiry as jwt.SignOptions['expiresIn'],
    });
  }

  /** Sign a refresh token; carries sandboxRunId so refreshes preserve the dev session. */
  private signRefreshToken(userId: string, sandboxRunId?: string): string {
    return jwt.sign(
      { sub: userId, type: 'refresh', ...(sandboxRunId ? { sandboxRunId } : {}) },
      this.jwtSecret,
      { expiresIn: this.refreshExpiry as jwt.SignOptions['expiresIn'] },
    );
  }

  /**
   * Issue normal access + refresh tokens for a user (shared by login + dev-login).
   * Normal login passes no sandboxRunId → behaviour identical to before.
   */
  private issueTokensForUser(user: TokenUser, sandboxRunId?: string) {
    return {
      accessToken: this.signAccessToken(user, sandboxRunId),
      refreshToken: this.signRefreshToken(user.id, sandboxRunId),
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

    // CR-2026-023 — each dev-login opens an ephemeral sandbox session (a TestDataRun
    // of runType DEV_LOGIN_SESSION). Records created during the session are tagged to
    // it and removable later via the existing cleanup engine.
    const run = await this.prisma.testDataRun.create({
      data: {
        label: `dev-session-${user.roleCode.toLowerCase()}-${Date.now()}-${randomUUID().slice(0, 8)}`,
        createdByUserId: user.id,
        status: 'ACTIVE',
        runType: 'DEV_LOGIN_SESSION',
        creationSummary: { kind: 'DEV_LOGIN_SESSION', role: user.roleCode },
      },
    });

    await this.audit.log({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.DEV_LOGIN,
      entityType: 'UserAccount',
      entityId: user.id,
      afterJson: { role: user.roleCode, email: user.email, sandboxRunId: run.id },
      reasonCode: 'DEV_LOGIN',
    });

    return { ...this.issueTokensForUser(user, run.id), sandboxRunId: run.id };
  }

  // --- CR-2026-023: dev sandbox session cleanup (current session only; gated) ---

  /** Resolve + gate the caller's own sandbox run id (never another run's). */
  private requireSandboxRun(user: JwtPayload): string {
    if (!this.devLoginEnabled()) throw new ForbiddenException('Dev login is disabled');
    if (!user.sandboxRunId) throw new ForbiddenException('No active dev sandbox session');
    return user.sandboxRunId;
  }

  /** Read-only preview: per-table counts + DEV_LOGIN_SESSION safety result. No deletes. */
  async devSandboxCleanupPreview(user: JwtPayload) {
    const runId = this.requireSandboxRun(user);
    const plan = await loadCleanupPlan(this.prisma, runId);
    const safety = evaluateSafety(plan.facts, 'DEV_LOGIN_SESSION');
    return {
      runId,
      label: plan.run?.label ?? null,
      status: plan.run?.status ?? null,
      runType: plan.run?.runType ?? null,
      counts: plan.deleteCounts,
      totalRows: plan.totalRows,
      safety,
      confirmationPhrase: DEV_SANDBOX_CONFIRM,
    };
  }

  /** Destructive: clean the caller's own sandbox run (typed confirmation required). */
  async devSandboxCleanup(user: JwtPayload, confirm: string) {
    const runId = this.requireSandboxRun(user);
    if (confirm !== DEV_SANDBOX_CONFIRM) {
      throw new BadRequestException(`Confirmation text must be exactly "${DEV_SANDBOX_CONFIRM}"`);
    }
    const plan = await loadCleanupPlan(this.prisma, runId);
    const safety = evaluateSafety(plan.facts, 'DEV_LOGIN_SESSION');
    if (!safety.pass) {
      const failed = safety.checks.filter((c) => !c.ok).map((c) => c.name).join('; ');
      throw new ForbiddenException(`Dev sandbox cleanup refused — safety failed: ${failed}`);
    }
    // Run the deletes OUTSIDE the sandbox context so the tagging/modification-guard
    // middleware does not block deletion of the very records being cleaned up.
    const result = await this.sandbox.exit(() =>
      executeCleanup(this.prisma, {
        runId,
        backup: 'dev-sandbox session (UI; dry-run + typed confirmation; no pg_dump)',
        actorUserId: user.sub,
        auditAction: AUDIT_ACTIONS.DEV_SANDBOX_CLEANED_UP,
        auditReasonCode: 'DEV_SANDBOX_CLEANUP',
      }),
    );
    return { ...result, runType: plan.run?.runType ?? null };
  }

  async refresh(refreshToken: string) {
    try {
      const decoded = jwt.verify(refreshToken, this.jwtSecret) as {
        sub: string;
        type: string;
        sandboxRunId?: string;
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

      // CR-2026-023 — preserve the dev-login sandbox run id across refreshes.
      const accessToken = this.signAccessToken(user, decoded.sandboxRunId);
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
