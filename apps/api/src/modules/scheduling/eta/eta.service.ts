/**
 * CR-2026-105b — ETA read-model service: loads rules + in-service state, runs the
 * pure model, and hands the SchedulingService the per-visit results to persist in
 * the same transaction as the ranking (ServiceVisit.currentEta*, QueueDecision.eta*,
 * ResourceOccupancy.expectedEndAt — all columns that existed unused since the
 * initial schema).
 *
 * Consumers (queue board, lobby display, dispatch, visit record, technician and
 * advisor views) do NOT recompute anything: they read the persisted times and call
 * `presentEta` with the presentation config from `loadRules`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { serviceVisitIsLive } from '../../../common/helpers/operational-scope';
import { ETA_RULE_KEYS, etaConfigFromRules, type EtaRuleValues } from './eta.config';
import {
  computeSiteEta,
  resolvePlannedMinutes,
  type EtaInServiceVisit,
  type EtaVisitResult,
  type EtaWaitingVisit,
  type InServiceStage,
} from './eta.model';

const HOLD_STATUSES = ['PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER'];
const LIVE_ORDER_STATUSES = ['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'WAITING_PARTS', 'WAITING_CUSTOMER', 'QC'];

@Injectable()
export class EtaService {
  private readonly logger = new Logger(EtaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Site-or-global rule rows (site wins), resolved to a typed config incl. capacity. */
  async loadRules(siteId: string): Promise<EtaRuleValues> {
    const rows = await this.prisma.businessRuleConfig.findMany({
      where: {
        ruleKey: { in: [...ETA_RULE_KEYS] },
        effectiveTo: null,
        OR: [{ siteId }, { siteId: null }],
      },
      select: { ruleKey: true, valueJson: true, siteId: true },
    });
    const cfg = etaConfigFromRules(rows);
    if (cfg.capacityMode === 'RESOURCES') {
      const agg = await this.prisma.workResource.aggregate({
        where: {
          siteId,
          isActive: true,
          schedulingEnabled: true,
          resourceCategory: { in: cfg.capacityResourceCategories as never[] },
        },
        _sum: { capacity: true },
      });
      const sum = agg._sum.capacity ?? 0;
      cfg.capacity = sum > 0 ? sum : cfg.capacity;
    }
    return cfg;
  }

  /**
   * Visits currently occupying a service position at the site, with everything the
   * model needs: start of the current attempt, closed/open holds, planned minutes
   * (KPI standard → item estimates → catalogue → default), and the stage.
   */
  async loadInService(siteId: string, now: Date, defaultMinutes: number): Promise<EtaInServiceVisit[]> {
    const visits = await this.prisma.serviceVisit.findMany({
      // Live operational visits only (CR-2026-006 scope): a historical import or a
      // test-data run left IN_SERVICE must never occupy a service position.
      where: { siteId, status: { in: ['IN_SERVICE', 'QC', 'WAITING_PARTS'] }, ...serviceVisitIsLive() },
      select: {
        id: true,
        status: true,
        serviceOrders: {
          where: { status: { in: LIVE_ORDER_STATUSES as never[] } },
          select: {
            status: true,
            startedAt: true,
            items: { select: { estimateMinutes: true, serviceType: { select: { baseDurationMinutes: true } } } },
            pauses: { select: { startedAt: true, endedAt: true } },
            kpiSnapshot: { select: { standardMinutes: true, customStandardMinutes: true } },
          },
        },
      },
    });

    // A visit whose status still reads in-service but which has NO live order is a
    // lifecycle leftover (its orders closed or were cancelled without the visit
    // following). It cannot be occupying a service position, so it must not cost
    // the next customer a track. Found live on the pilot data (three such visits).
    const occupying = visits.filter((v) => v.serviceOrders.length > 0);
    if (occupying.length !== visits.length) {
      this.logger.warn(
        `ETA: ${visits.length - occupying.length} in-service visit(s) at site ${siteId} have no live order and were not counted as occupying a position`,
      );
    }

    return occupying.map((v) => {
      const orders = v.serviceOrders;
      const started = orders.map((o) => o.startedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? now;

      let closedPauseMinutes = 0;
      let openPauseStartedAt: Date | null = null;
      for (const o of orders) {
        for (const p of o.pauses) {
          if (p.endedAt) closedPauseMinutes += (p.endedAt.getTime() - p.startedAt.getTime()) / 60_000;
          else if (!openPauseStartedAt || p.startedAt < openPauseStartedAt) openPauseStartedAt = p.startedAt;
        }
      }

      const kpiStandard = orders.reduce((s, o) => {
        const std = o.kpiSnapshot?.customStandardMinutes ?? o.kpiSnapshot?.standardMinutes ?? 0;
        return s + (std > 0 ? std : 0);
      }, 0);
      const plannedMinutes = resolvePlannedMinutes(
        {
          kpiStandardMinutes: kpiStandard > 0 ? kpiStandard : null,
          orderItems: orders.flatMap((o) =>
            o.items.map((i) => ({ estimateMinutes: i.estimateMinutes, baseDurationMinutes: i.serviceType.baseDurationMinutes })),
          ),
        },
        defaultMinutes,
      );

      const onHold = orders.some((o) => HOLD_STATUSES.includes(o.status)) || v.status === 'WAITING_PARTS';
      const allQc = orders.length > 0 && orders.every((o) => o.status === 'QC');
      const stage: InServiceStage = onHold ? 'HOLD' : allQc || v.status === 'QC' ? 'QC' : 'IN_PROGRESS';

      return {
        serviceVisitId: v.id,
        startedAt: started,
        plannedMinutes,
        closedPauseMinutes,
        openPauseStartedAt: onHold ? openPauseStartedAt ?? now : null,
        stage,
      };
    });
  }

  /** Run the model for a site given the ranked waiting visits (from the priority engine). */
  async project(siteId: string, now: Date, waiting: EtaWaitingVisit[]): Promise<{ results: Map<string, EtaVisitResult>; rules: EtaRuleValues }> {
    const rules = await this.loadRules(siteId);
    const inService = await this.loadInService(siteId, now, rules.defaultDurationMinutes);
    const results = computeSiteEta(now, rules, inService, waiting);
    this.logger.debug(
      `ETA projected for site ${siteId}: ${inService.length} in service, ${waiting.length} waiting, capacity ${rules.capacity}`,
    );
    return { results: new Map(results.map((r) => [r.serviceVisitId, r])), rules };
  }
}
