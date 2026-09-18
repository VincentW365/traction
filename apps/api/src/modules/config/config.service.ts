import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ResourceReadinessService } from '../resources/resource-readiness.service';

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
