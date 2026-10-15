import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ResourceReadinessService } from '../resources/resource-readiness.service';
import {
  LIVE_SENDING_RULE,
  NotificationRoutingService,
} from '../notifications/notification-routing.service';
import {
  NOTIFICATION_CAPABILITIES,
  type NotificationCapabilities,
} from '../notifications/providers/notification-provider.interface';

/**
 * CR-2026-108 Stage 5C §14 — the values of `booking_capacity_mode` that hand
 * customer-facing decisions to the resource model. Reaching one of these is
 * guarded by a preflight; everything else about this service is unchanged.
 */
const RESOURCE_AWARE_MODES = ['RESOURCE_AWARE', 'RESOURCES'];

@Injectable()
export class ConfigService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private readonly readiness: ResourceReadinessService,
    // CR-2026-117 — whether a mailbox is wired at all. @Optional so the existing
    // config specs that construct this service directly keep compiling; absent
    // means the live-sending guard cannot confirm a mailbox and refuses, which
    // is the safe direction.
    @Optional()
    @Inject(NOTIFICATION_CAPABILITIES)
    private readonly emailCapabilities?: NotificationCapabilities,
  ) {}

  async listRules(siteId?: string) {
    const now = new Date();
    const rules = await this.prisma.businessRuleConfig.findMany({
      where: {
        AND: [
          siteId ? { OR: [{ siteId }, { siteId: null }] } : {},
          { effectiveFrom: { lte: now } },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
        ],
      },
      orderBy: { ruleKey: 'asc' },
      include: {
        createdBy: { select: { fullName: true } },
      },
    });

    return rules;
  }

  async updateRule(
    ruleKey: string,
    siteId: string,
    value: unknown,
    userId: string,
    effectiveFrom?: string,
    notes?: string,
  ) {
    // CR-2026-117 §4 — turning live sending on is the moment this installation
    // starts writing to real customers, so it may not be done on a deployment
    // that cannot actually send. A switch reading ON while every message is
    // still recorded as simulated is worse than one that refuses: the first
    // anyone would learn of it is a customer who never got told their car was
    // ready.
    if (ruleKey === LIVE_SENDING_RULE && value === true) {
      if (!this.emailCapabilities?.emailConfigured) {
        throw new BadRequestException({
          code: 'EMAIL_MAILBOX_NOT_CONFIGURED',
          message: NotificationRoutingService.mailboxMissingMessage(),
        });
      }
    }

    // CR-2026-108 §14 — handing customer-facing capacity decisions to the resource
    // model is the one config change that can strand a real vehicle, so it is the
    // one that has to earn it. Everything else on this path is unchanged.
    if (ruleKey === 'booking_capacity_mode' && typeof value === 'string' && RESOURCE_AWARE_MODES.includes(value)) {
      const blockers = await this.readiness.productionActivationBlockers(siteId);
      if (blockers.length > 0) {
        throw new BadRequestException({
          code: 'RESOURCE_AWARE_PREFLIGHT_FAILED',
          message:
            `The resource-aware model cannot decide what customers are offered yet — ${blockers.length} preflight check(s) fail. ` +
            'Production stays on the fixed limit until they pass.',
          blockers,
        });
      }
    }

    // Find current active rule
    const now = new Date();
    const current = await this.prisma.businessRuleConfig.findFirst({
      where: {
        ruleKey,
        OR: [{ siteId }, { siteId: null }],
        effectiveFrom: { lte: now },
        AND: [
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
        ],
      },
      orderBy: { siteId: 'desc' }, // site-specific first
    });

    if (!current) {
      throw new NotFoundException(
        `Business rule '${ruleKey}' not found for site ${siteId}`,
      );
    }

    const beforeValue = current.valueJson;

    // Expire the current rule
    await this.prisma.businessRuleConfig.update({
      where: { id: current.id },
      data: { effectiveTo: now },
    });

    // Create new version
    const newRule = await this.prisma.businessRuleConfig.create({
      data: {
        ruleKey,
        siteId,
        valueJson: value as any,
        effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : now,
        notes,
        createdByUserId: userId,
      },
    });

    // Audit log
    await this.auditService.log({
      actorUserId: userId,
      action: 'CONFIG_CHANGE',
      entityType: 'BusinessRuleConfig',
      entityId: newRule.id,
      beforeJson: { ruleKey, value: beforeValue },
      afterJson: { ruleKey, value },
      notes,
    });

    return newRule;
  }

  async getRuleHistory(ruleKey: string, siteId?: string) {
    return this.prisma.businessRuleConfig.findMany({
      where: {
        ruleKey,
        ...(siteId ? { OR: [{ siteId }, { siteId: null }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { fullName: true } },
      },
    });
  }
}
