import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface DashboardStats {
  carsToday: number;
  activeTechnicians: number;
  jobsInProgress: number;
  queueDepth: number;
  avgWaitMinutes: number;
  overridesToday: number;
  blockedOrders: number;
  partsPending: number;
}

export interface DashboardAlert {
  type: 'OVERDUE_JOB' | 'BLOCKED_PARTS' | 'ABSENT_TECH' | 'INTEGRATION_ERROR';
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  entityId?: string;
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
    const carsToday = await this.prisma.serviceVisit.count({
      where: {
        siteId,
        createdAt: { gte: todayStart, lte: todayEnd },
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
        serviceVisit: { siteId },
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
      },
    });

    // Queue depth (active queue tickets)
    const queueDepth = await this.prisma.queueTicket.count({
      where: {
        serviceVisit: { siteId },
        displayStatus: { in: ['WAITING', 'ISSUED', 'PENDING_RANK'] },
      },
    });

    // Average wait time for tickets waiting today
    const waitingTickets = await this.prisma.queueTicket.findMany({
      where: {
        serviceVisit: { siteId },
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
        serviceVisit: { siteId },
        overrideAppliedAt: { gte: todayStart, lte: todayEnd },
      },
    });

    // Blocked orders
    const blockedOrders = await this.prisma.serviceOrder.count({
      where: {
        serviceVisit: { siteId },
        status: 'WAITING_PARTS',
      },
    });

    // Parts pending
    const partsPending = await this.prisma.partsRequest.count({
      where: {
        serviceOrder: { serviceVisit: { siteId } },
        status: { in: ['OPEN', 'RESERVING', 'PARTIAL'] },
      },
    });

    return {
      carsToday,
      activeTechnicians,
      jobsInProgress,
      queueDepth,
      avgWaitMinutes,
      overridesToday,
      blockedOrders,
      partsPending,
    };
  }

  async getAlerts(siteId: string): Promise<DashboardAlert[]> {
    const alerts: DashboardAlert[] = [];
    const now = new Date();

    // Overdue jobs (in progress > 2 hours since started)
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const overdueOrders = await this.prisma.serviceOrder.findMany({
      where: {
        serviceVisit: { siteId },
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
        startedAt: { lt: twoHoursAgo, not: null },
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

    for (const order of overdueOrders) {
      const elapsed = Math.round((now.getTime() - order.startedAt!.getTime()) / 60000);
      const sv = order.serviceVisit;
      alerts.push({
        type: 'OVERDUE_JOB',
        severity: elapsed > 240 ? 'critical' : 'warning',
        title: `Job overdue (${elapsed} min)`,
        detail: `${sv.customer.firstName} ${sv.customer.lastName} — ${sv.vehicle.plateNumber}`,
        entityId: order.id,
      });
    }

    // Blocked by parts
    const blockedParts = await this.prisma.queueTicket.findMany({
      where: {
        serviceVisit: { siteId },
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
