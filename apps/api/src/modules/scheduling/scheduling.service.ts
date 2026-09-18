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
import { EtaService } from './eta/eta.service';
import { resolvePlannedMinutes, type EtaWaitingVisit } from './eta/eta.model';
import type { VehicleClass } from './availability/service-duration';

@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    // CR-2026-105b — the authoritative ETA projection runs here, AFTER ranking and
    // inside the same advisory lock + transaction, so every recompute republishes
    // one consistent set of estimates and the socket poke that follows is true.
    private eta: EtaService,
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
              // CR-2026-111b — the class the planned duration depends on.
              vehicle: { select: { serviceClass: true } },
              serviceOrders: {
                include: {
                  partsRequests: {
                    include: { items: true },
                  },
                  items: { include: { serviceType: true } },
                  // CR-2026-105b — an open rework means only part of the planned
                  // time remains; the ETA model assumes the configured share.
                  reworks: { where: { closedAt: null }, select: { id: true } },
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

      // 6b. CR-2026-105b — project estimated start/completion for every visit at
      //     the site. Strictly downstream of ranking: the model receives the
      //     positions the engine just produced and returns times; nothing it
      //     returns is fed back into `calculatePriorityPositions` or written to
      //     any field the ranker reads (queueRank, displayStatus, overrides,
      //     checkinSequence, blockedReason). FIFO-first (CR-2026-099b) is untouched.
      const ticketById = new Map(tickets.map((t) => [t.id, t]));
      let etaByVisit = new Map<string, { estimatedStartAt: Date | null; estimatedCompleteAt: Date | null }>();
      try {
        const etaRules = await this.eta.loadRules(siteId);
        const waiting: EtaWaitingVisit[] = results.map((r) => {
          const t = ticketById.get(r.queueTicketId);
          const sv = t?.serviceVisit;
          const plannedMinutes = resolvePlannedMinutes(
            {
              orderItems: sv?.serviceOrders?.flatMap((so) =>
                so.items.map((i) => ({
                  estimateMinutes: i.estimateMinutes,
                  baseDurationMinutes: i.serviceType.baseDurationMinutes,
                })),
              ),
              appointmentServices: sv?.appointment?.services?.map((s) => ({
                code: s.serviceType.code,
                baseDurationMinutes: s.serviceType.baseDurationMinutes,
                sedanDurationMinutes: s.serviceType.sedanDurationMinutes,
                suvDurationMinutes: s.serviceType.suvDurationMinutes,
                qty: s.qty,
              })),
              // CR-2026-111b — the waiting vehicle's own class. A queue ETA built
              // on the sedan figure for an SUV is wrong for that customer and for
              // everyone behind them in the queue.
              vehicleClass: (sv?.vehicle?.serviceClass ?? null) as VehicleClass,
            },
            etaRules.defaultDurationMinutes,
          );
          return {
            serviceVisitId: r.serviceVisitId,
            position: r.position,
            plannedMinutes,
            isRework: sv?.serviceOrders?.some((so) => so.reworks.length > 0) ?? false,
          };
        });
        const projected = await this.eta.project(siteId, now, waiting);
        etaByVisit = projected.results;
      } catch (err) {
        // An ETA failure must never stop the queue from being ranked; the boards
        // simply keep the last published estimate until the next recompute.
        this.logger.error(`ETA projection failed for site ${siteId}: ${(err as Error).message}`);
      }

      // 7. Persist positions + class + readiness in a transaction; write an
      //    explainable QueueDecision snapshot whenever rank or class changed.
      const priorByTicket = new Map(
        tickets.map((t) => [t.id, { rank: t.queueRank, cls: t.serviceVisit.queuePriorityClass }]),
      );
      const rankedVisitIds = new Set(results.map((r) => r.serviceVisitId));
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
          const eta = etaByVisit.get(result.serviceVisitId);
          await tx.serviceVisit.update({
            where: { id: result.serviceVisitId },
            data: {
              ...(partsInfo ? { partsReadiness: partsInfo.readiness as any } : {}),
              ...(effectiveClass ? { queuePriorityClass: effectiveClass as any } : {}),
              // CR-2026-105b — the authoritative estimate (null when blocked).
              ...(eta ? { currentEtaStartAt: eta.estimatedStartAt, currentEtaCompleteAt: eta.estimatedCompleteAt } : {}),
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
                // CR-2026-105b — the estimate that accompanied this decision.
                etaStartAt: eta?.estimatedStartAt ?? null,
                etaCompleteAt: eta?.estimatedCompleteAt ?? null,
              },
            });
          }
        }

        // CR-2026-105b — visits already in service (not part of the ranked set)
        // get their republished completion too, and the bay they occupy learns
        // when it is expected to free up.
        for (const [visitId, eta] of etaByVisit) {
          if (rankedVisitIds.has(visitId)) continue;
          await tx.serviceVisit.update({
            where: { id: visitId },
            data: { currentEtaStartAt: eta.estimatedStartAt, currentEtaCompleteAt: eta.estimatedCompleteAt },
          });
          await tx.resourceOccupancy.updateMany({
            where: { serviceVisitId: visitId, status: 'OCCUPIED' },
            data: { expectedEndAt: eta.estimatedCompleteAt },
          });
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
