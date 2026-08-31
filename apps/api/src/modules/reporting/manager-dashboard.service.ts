import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { liveVisitWhere, operationalVisitWhere } from '../../common/helpers/operational-scope';

export interface DashboardStats {
  carsToday: number;
  activeTechnicians: number;
  jobsInProgress: number;
  queueDepth: number;
  avgWaitMinutes: number;
  overridesToday: number;
  /** Orders currently in the WAITING_PARTS state (live visits) — CR-2026-098. */
  waitingParts: number;
  /** Orders currently PAUSED (live visits) — delayed work that is not parts. */
  pausedJobs: number;
}

// CR-2026-098 — INTEGRATION_ERROR removed: the platform is standalone and no
// generator ever produced that alert type.
export interface DashboardAlert {
  type: 'OVERDUE_JOB' | 'BLOCKED_PARTS' | 'WAITING_PARTS' | 'ABSENT_TECH' | 'READY_FOR_QC';
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  entityId?: string;
  /** Queue ticket behind the alert, so the UI can link straight to the visit workspace. */
  queueTicketId?: string;
}

@Injectable()
export class ManagerDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(siteId: string): Promise<DashboardStats> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Cars today (service visits created today)
    // CR-2026-006: always exclude HISTORICAL_IMPORT visits (no opt-in on live
    // dashboards). Real leak — historical visits were imported with a recent
    // createdAt and would otherwise inflate today's count.
    const carsToday = await this.prisma.serviceVisit.count({
      where: {
        siteId,
        createdAt: { gte: todayStart, lte: todayEnd },
        ...liveVisitWhere(false),
      },
    });

    // Active technicians (on-floor today)
    const activeTechnicians = await this.prisma.technician.count({
      where: {
        homeSiteId: siteId,
        status: 'ACTIVE',
      },
    });

    // Jobs in progress
    const jobsInProgress = await this.prisma.serviceOrder.count({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() }, // CR-2026-006: always live
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
      },
    });

    // Queue depth (active queue tickets)
    const queueDepth = await this.prisma.queueTicket.count({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() }, // CR-2026-006: always live
        displayStatus: { in: ['WAITING', 'ISSUED', 'PENDING_RANK'] },
      },
    });

    // Average wait time for tickets waiting today
    const waitingTickets = await this.prisma.queueTicket.findMany({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() }, // CR-2026-006: always live
        displayStatus: 'WAITING',
        generatedAt: { gte: todayStart },
      },
      select: { generatedAt: true },
    });

    let avgWaitMinutes = 0;
    if (waitingTickets.length > 0) {
      const now = Date.now();
      const totalMinutes = waitingTickets.reduce(
        (sum, t) => sum + (now - t.generatedAt.getTime()) / 60000,
        0,
      );
      avgWaitMinutes = Math.round(totalMinutes / waitingTickets.length);
    }

    // Overrides today
    const overridesToday = await this.prisma.queueTicket.count({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() }, // CR-2026-006: always live
        overrideAppliedAt: { gte: todayStart, lte: todayEnd },
      },
    });

    // CR-2026-098 — Waiting for Parts is counted from the operational state
    // itself: orders sitting in WAITING_PARTS on live visits. (The old tile pair
    // was "Blocked Orders" — this same query under a misleading name — plus a
    // "Parts Pending" count of parts-request rows that no UI flow ever creates,
    // which read as a permanently-zero metric.)
    const waitingParts = await this.prisma.serviceOrder.count({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() }, // CR-2026-006: always live
        status: 'WAITING_PARTS',
      },
    });

    // Paused jobs — delayed work that is NOT parts (authorization, assistance, …).
    const pausedJobs = await this.prisma.serviceOrder.count({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() },
        status: 'PAUSED',
      },
    });

    return {
      carsToday,
      activeTechnicians,
      jobsInProgress,
      queueDepth,
      avgWaitMinutes,
      overridesToday,
      waitingParts,
      pausedJobs,
    };
  }

  async getAlerts(siteId: string): Promise<DashboardAlert[]> {
    const alerts: DashboardAlert[] = [];
    const now = new Date();

    // Overdue jobs (in progress > 2 hours since started)
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const overdueOrders = await this.prisma.serviceOrder.findMany({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() }, // CR-2026-006: always live
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
        startedAt: { lt: twoHoursAgo, not: null },
      },
      include: {
        serviceVisit: {
          select: {
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true } },
            queueTicket: { select: { id: true } },
          },
        },
      },
      take: 10,
    });

    for (const order of overdueOrders) {
      const elapsed = Math.round((now.getTime() - order.startedAt!.getTime()) / 60000);
      const sv = order.serviceVisit;
      alerts.push({
        type: 'OVERDUE_JOB',
        severity: elapsed > 240 ? 'critical' : 'warning',
        title: `Job overdue (${elapsed} min)`,
        detail: `${sv.customer.firstName} ${sv.customer.lastName} — ${sv.vehicle.plateNumber}`,
        entityId: order.id,
        queueTicketId: sv.queueTicket?.id,
      });
    }

    // CR-2026-074 — jobs a technician finished and handed to QC (order status QC).
    const qcOrders = await this.prisma.serviceOrder.findMany({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() },
        status: 'QC',
      },
      include: {
        serviceVisit: {
          select: {
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true } },
            queueTicket: { select: { id: true, ticketNumber: true } },
          },
        },
      },
      orderBy: { completedAt: 'asc' },
      take: 10,
    });

    for (const order of qcOrders) {
      const sv = order.serviceVisit;
      alerts.push({
        type: 'READY_FOR_QC',
        severity: 'warning',
        title: `Ready for QC${sv.queueTicket?.ticketNumber ? ` — ${sv.queueTicket.ticketNumber}` : ''}`,
        detail: `${sv.customer.firstName} ${sv.customer.lastName} — ${sv.vehicle.plateNumber}`,
        entityId: order.id,
        queueTicketId: sv.queueTicket?.id,
      });
    }

    // CR-2026-098 — jobs a technician put into Waiting for Parts, with how long
    // they have been waiting (from the open ledger interval).
    const waitingPartsOrders = await this.prisma.serviceOrder.findMany({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() },
        status: 'WAITING_PARTS',
      },
      include: {
        pauses: { where: { endedAt: null, reasonCode: 'WAITING_PARTS' }, select: { startedAt: true } },
        serviceVisit: {
          select: {
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true } },
            queueTicket: { select: { id: true, ticketNumber: true } },
          },
        },
      },
      take: 10,
    });
    for (const order of waitingPartsOrders) {
      const sv = order.serviceVisit;
      const since = order.pauses[0]?.startedAt;
      const waitMin = since ? Math.round((now.getTime() - since.getTime()) / 60000) : null;
      alerts.push({
        type: 'WAITING_PARTS',
        severity: waitMin != null && waitMin > 240 ? 'critical' : 'warning',
        title: `Waiting for parts${waitMin != null ? ` (${waitMin} min)` : ''}${sv.queueTicket?.ticketNumber ? ` — ${sv.queueTicket.ticketNumber}` : ''}`,
        detail: `${sv.customer.firstName} ${sv.customer.lastName} — ${sv.vehicle.plateNumber}`,
        entityId: order.id,
        queueTicketId: sv.queueTicket?.id,
      });
    }

    // Blocked by parts
    const blockedParts = await this.prisma.queueTicket.findMany({
      where: {
        serviceVisit: { siteId, ...operationalVisitWhere() }, // CR-2026-006: always live
        displayStatus: 'BLOCKED',
        blockedReason: { contains: 'parts', mode: 'insensitive' },
      },
      include: {
        serviceVisit: {
          select: {
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true } },
          },
        },
      },
      take: 10,
    });

    for (const ticket of blockedParts) {
      const sv = ticket.serviceVisit;
      alerts.push({
        type: 'BLOCKED_PARTS',
        severity: 'warning',
        title: `Blocked by parts — ${ticket.ticketNumber}`,
        detail: `${sv.customer.firstName} ${sv.customer.lastName} — ${sv.vehicle.plateNumber}`,
        entityId: ticket.id,
        queueTicketId: ticket.id,
      });
    }

    // Absent technicians today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const absentTechs = await this.prisma.mechanicDayAvailability.findMany({
      where: {
        technician: { homeSiteId: siteId },
        date: { gte: todayStart, lte: todayEnd },
        status: 'ABSENT',
      },
      include: {
        technician: {
          select: {
            employeeCode: true,
            userAccount: { select: { fullName: true } },
          },
        },
      },
    });

    for (const absence of absentTechs) {
      alerts.push({
        type: 'ABSENT_TECH',
        severity: 'warning',
        title: `Absent today — ${absence.technician.employeeCode}`,
        detail: absence.technician.userAccount.fullName,
        entityId: absence.technicianId,
      });
    }

    return alerts;
  }
}
