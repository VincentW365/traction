import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ConfigService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
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
