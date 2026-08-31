/**
 * Scheduling Service v3 — the priority engine, live (CR-2026-099).
 *
 * Ranking: priority classes + configurable scoring (appointment protection,
 * lateness, wait-time fairness, fast-track) via the pure
 * priority-position.calculator, driven by the business rules a manager edits
 * under Settings → Queue Tuning / Priority Weights. Blocked tickets still step
 * aside; manager overrides still pin their exact position; each ranking writes
 * an explainable QueueDecision snapshot when a ticket's position or class
 * changes.
 *
 * Atomic consistency: uses PostgreSQL advisory lock per site.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  calculatePriorityPositions,
  configFromRules,
  PRIORITY_RULE_KEYS,
  PriorityTicket,
} from './engine/priority-position.calculator';
import {
  derivePartsReadiness,
  isPartsReadyForDispatch,
} from './engine/parts-readiness.checker';

@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  async recomputeQueue(siteId: string): Promise<void> {
    const start = Date.now();
    const now = new Date();

    // 1. Acquire advisory lock (serializes recomputes per site)
    await this.prisma.$executeRaw`SELECT pg_advisory_lock(hashtext(${siteId}))`;

    try {
      // 2. Load active tickets with parts data for readiness check
      const tickets = await this.prisma.queueTicket.findMany({
        where: {
          serviceVisit: {
            siteId,
            status: { in: ['CHECKED_IN', 'QUEUED', 'CALLED'] },
          },
          displayStatus: {
            in: ['PENDING_RANK', 'WAITING', 'CALLED', 'BLOCKED'],
          },
        },
        include: {
          serviceVisit: {
            include: {
              appointment: {
                include: { services: { include: { serviceType: true } } },
              },
              serviceOrders: {
                include: {
                  partsRequests: {
                    include: { items: true },
                  },
                  items: { include: { serviceType: true } },
                },
              },
            },
          },
        },
        orderBy: { checkinSequence: 'asc' },
      });

      // CR-2026-084 — deliberately NO early return here. This used to `return` when
      // the queue was empty, which skipped the `queue.recomputed` emit at the end of
      // the method, so the boards and the lobby display never heard about the change
      // that emptied the queue and kept showing the last car indefinitely. Every step
      // below is a no-op on an empty list, so falling through is safe and the event
      // always fires.
      if (tickets.length === 0) {
        this.logger.log(`No active tickets for site ${siteId} — clearing the board`);
      }

      // 3. Evaluate parts readiness for each ticket
      const ticketReadiness = new Map<string, { readiness: string; blocked: boolean; reason: string | null }>();

      for (const t of tickets) {
        const sv = t.serviceVisit;
        // Gather service types from appointment services or service order items
        const serviceTypes = [
          ...(sv.appointment?.services?.map((s) => s.serviceType) ?? []),
          ...(sv.serviceOrders?.flatMap((so) => so.items.map((i) => i.serviceType)) ?? []),
        ];
        const partsRequests = sv.serviceOrders?.flatMap((so) => so.partsRequests) ?? [];

        const readiness = derivePartsReadiness(serviceTypes, partsRequests);
        const partsBlocked = !isPartsReadyForDispatch(readiness);

        ticketReadiness.set(t.id, {
          readiness,
          blocked: partsBlocked,
          reason: partsBlocked ? 'Waiting for parts' : null,
        });
      }

      // 4. Check resource-type existence at site (can any compatible resource exist?)
      const siteResources = await this.prisma.workResource.findMany({
        where: { siteId, isActive: true },
        select: { id: true, resourceCategory: true, maxVehicleWeight: true },
      });

      // 5. Map to engine input — blocked if parts not ready OR was already blocked
      const engineTickets: PriorityTicket[] = tickets.map((t) => {
        const partsInfo = ticketReadiness.get(t.id);
        const isBlocked = partsInfo?.blocked || t.displayStatus === 'BLOCKED';
        const blockedReason = partsInfo?.blocked
          ? (partsInfo.reason ?? 'Waiting for parts')
          : (t.displayStatus === 'BLOCKED' ? this.getLegacyBlockedReason(t.serviceVisit) : null);

        const sv = t.serviceVisit;
        const serviceTypes = [
          ...(sv.appointment?.services?.map((s) => s.serviceType) ?? []),
          ...(sv.serviceOrders?.flatMap((so) => so.items.map((i) => i.serviceType)) ?? []),
        ];
        return {
          queueTicketId: t.id,
          serviceVisitId: t.serviceVisitId,
          checkinSequence: t.checkinSequence,
          displayStatus: isBlocked ? 'BLOCKED' : t.displayStatus,
          overrideActive: t.overrideActive,
          overrideRankPosition: t.overrideRankPosition,
          blockedReason,
          checkedInAt: sv.checkedInAt ?? sv.arrivalAt ?? null,
          scheduledStartAt: sv.appointment?.scheduledStartAt ?? null,
          // Fast-track only when the visit actually asked for something and all
          // of it is quick service — an empty list is not a fast pass.
          allQuickService: serviceTypes.length > 0 && serviceTypes.every((st) => st.quickService),
        };
      });

      // 6. Rank via the priority engine, configured by the live business rules.
      const rules = await this.prisma.businessRuleConfig.findMany({
        where: { ruleKey: { in: [...PRIORITY_RULE_KEYS] }, effectiveTo: null },
        select: { ruleKey: true, valueJson: true },
      });
      const cfg = configFromRules(rules);
      const results = calculatePriorityPositions(engineTickets, now, cfg);

      // 7. Persist positions + class + readiness in a transaction; write an
      //    explainable QueueDecision snapshot whenever rank or class changed.
      const priorByTicket = new Map(
        tickets.map((t) => [t.id, { rank: t.queueRank, cls: t.serviceVisit.queuePriorityClass }]),
      );
      await this.prisma.$transaction(async (tx) => {
        for (const result of results) {
          const partsInfo = ticketReadiness.get(result.queueTicketId);
          const newStatus =
            result.displayStatus === 'BLOCKED'
              ? 'BLOCKED'
              : result.displayStatus === 'CALLED'
                ? 'CALLED'
                : 'WAITING';

          // Determine readyForDispatch: has position + parts OK + at least one resource type exists
          const readyForDispatch =
            result.position !== null &&
            (partsInfo ? isPartsReadyForDispatch(partsInfo.readiness as any) : true) &&
            siteResources.length > 0;

          await tx.queueTicket.update({
            where: { id: result.queueTicketId },
            data: {
              queueRank: result.position,
              displayStatus: newStatus as any,
              lastRankedAt: now,
              blockedReason: result.blockedReason,
              readyForDispatch,
            },
          });

          const prior = priorByTicket.get(result.queueTicketId);
          const effectiveClass = result.priorityClass ?? (result.blockedReason?.toLowerCase().includes('parts') ? 'BLOCKED_PARTS' : prior?.cls ?? null);
          await tx.serviceVisit.update({
            where: { id: result.serviceVisitId },
            data: {
              ...(partsInfo ? { partsReadiness: partsInfo.readiness as any } : {}),
              ...(effectiveClass ? { queuePriorityClass: effectiveClass as any } : {}),
            },
          });

          // Decision snapshot only on change — full auditability without a row
          // per ticket per recompute.
          const changed = prior?.rank !== result.position || prior?.cls !== effectiveClass;
          if (changed && effectiveClass) {
            await tx.queueDecision.create({
              data: {
                serviceVisitId: result.serviceVisitId,
                priorityClass: effectiveClass as any,
                score: result.score,
                blockedReason: result.blockedReason,
                reasonCodes: result.reasons as any,
              },
            });
          }
        }
      });

      const duration = Date.now() - start;
      const positioned = results.filter((r) => r.position !== null).length;
      const blocked = results.filter((r) => r.position === null).length;
      this.logger.log(
        `Priority recompute for site ${siteId}: ${positioned} positioned, ${blocked} blocked (${duration}ms)`,
      );
    } finally {
      // 8. Release advisory lock
      await this.prisma.$executeRaw`SELECT pg_advisory_unlock(hashtext(${siteId}))`;
    }

    // 9. Emit event for WebSocket broadcast (outside lock)
    this.eventEmitter.emit('queue.recomputed', {
      siteId,
      updatedAt: new Date(),
    });
  }

  private getLegacyBlockedReason(visit: { queuePriorityClass: string | null }): string {
    if (visit.queuePriorityClass === 'BLOCKED_PARTS') return 'Waiting for parts';
    if (visit.queuePriorityClass === 'BLOCKED_SKILL') return 'No qualified technician available';
    return 'Blocked';
  }
}
