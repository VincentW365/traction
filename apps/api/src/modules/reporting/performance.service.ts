import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface TechnicianEfficiencyRow {
  technicianId: string;
  employeeCode: string;
  fullName: string;
  jobsCompleted: number;
  flaggedMinutes: number;
  clockMinutes: number;
  efficiencyPercent: number;
}

export interface AssignmentHistoryRow {
  id: string;
  serviceOrderId: string;
  technicianName: string;
  employeeCode: string;
  isPrimary: boolean;
  status: string;
  assignedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number | null;
  customerName: string;
  vehiclePlate: string;
}

@Injectable()
export class PerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getTechnicianEfficiency(
    siteId: string,
    startDate: string,
    endDate: string,
  ): Promise<TechnicianEfficiencyRow[]> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const technicians = await this.prisma.technician.findMany({
      where: { homeSiteId: siteId, status: 'ACTIVE' },
      include: {
        userAccount: { select: { fullName: true } },
        assignments: {
          where: {
            assignedAt: { gte: start, lte: end },
          },
          include: {
            serviceOrder: {
              include: {
                items: { select: { estimateMinutes: true, actualMinutes: true } },
              },
            },
          },
        },
      },
    });

    return technicians.map((tech) => {
      let flaggedMinutes = 0;
      let clockMinutes = 0;
      let jobsCompleted = 0;

      for (const assignment of tech.assignments) {
        // Clock time = actual time worked on this assignment
        if (assignment.startedAt && assignment.endedAt) {
          clockMinutes += Math.round(
            (assignment.endedAt.getTime() - assignment.startedAt.getTime()) / 60000,
          );
        }

        // Flagged time = sum of estimated minutes for order items
        if (assignment.isPrimary && assignment.serviceOrder?.items) {
          for (const item of assignment.serviceOrder.items) {
            flaggedMinutes += item.estimateMinutes ?? 0;
          }
        }

        if (assignment.status === 'COMPLETED') {
          jobsCompleted++;
        }
      }

      const efficiencyPercent =
        clockMinutes > 0 ? Math.round((flaggedMinutes / clockMinutes) * 100) : 0;

      return {
        technicianId: tech.id,
        employeeCode: tech.employeeCode,
        fullName: tech.userAccount.fullName,
        jobsCompleted,
        flaggedMinutes,
        clockMinutes,
        efficiencyPercent,
      };
    });
  }

  async getTechnicianPerformance(technicianId: string, startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const tech = await this.prisma.technician.findUnique({
      where: { id: technicianId },
      include: { userAccount: { select: { fullName: true } } },
    });

    const assignments = await this.prisma.technicianAssignment.findMany({
      where: {
        technicianId,
        assignedAt: { gte: start, lte: end },
      },
      include: {
        serviceOrder: {
          include: {
            items: { include: { serviceType: { select: { name: true, family: true } } } },
            serviceVisit: {
              select: {
                customer: { select: { firstName: true, lastName: true } },
                vehicle: { select: { plateNumber: true } },
              },
            },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });

    const totalJobs = assignments.filter((a) => a.status === 'COMPLETED').length;
    let totalClockMinutes = 0;
    let totalFlaggedMinutes = 0;

    for (const a of assignments) {
      if (a.startedAt && a.endedAt) {
        totalClockMinutes += Math.round(
          (a.endedAt.getTime() - a.startedAt.getTime()) / 60000,
        );
      }
      if (a.isPrimary && a.serviceOrder?.items) {
        for (const item of a.serviceOrder.items) {
          totalFlaggedMinutes += item.estimateMinutes ?? 0;
        }
      }
    }

    const avgJobMinutes = totalJobs > 0 ? Math.round(totalClockMinutes / totalJobs) : 0;
    const efficiencyPercent = totalClockMinutes > 0
      ? Math.round((totalFlaggedMinutes / totalClockMinutes) * 100)
      : 0;

    return {
      technicianId,
      employeeCode: tech?.employeeCode ?? '',
      fullName: tech?.userAccount.fullName ?? '',
      totalJobs,
      totalClockMinutes,
      totalFlaggedMinutes,
      avgJobMinutes,
      efficiencyPercent,
      assignments: assignments.map((a) => ({
        id: a.id,
        isPrimary: a.isPrimary,
        status: a.status,
        assignedAt: a.assignedAt.toISOString(),
        startedAt: a.startedAt?.toISOString() ?? null,
        endedAt: a.endedAt?.toISOString() ?? null,
        durationMinutes: a.startedAt && a.endedAt
          ? Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 60000)
          : null,
        customerName: a.serviceOrder?.serviceVisit
          ? `${a.serviceOrder.serviceVisit.customer.firstName} ${a.serviceOrder.serviceVisit.customer.lastName}`
          : '',
        vehiclePlate: a.serviceOrder?.serviceVisit?.vehicle.plateNumber ?? '',
        services: a.serviceOrder?.items.map((i) => i.serviceType.name) ?? [],
      })),
    };
  }

  async getAssignmentHistory(siteId: string, startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const assignments = await this.prisma.technicianAssignment.findMany({
      where: {
        assignedAt: { gte: start, lte: end },
        technician: { homeSiteId: siteId },
      },
      include: {
        technician: {
          select: { employeeCode: true, userAccount: { select: { fullName: true } } },
        },
        serviceOrder: {
          select: {
            id: true,
            status: true,
            serviceVisit: {
              select: {
                customer: { select: { firstName: true, lastName: true } },
                vehicle: { select: { plateNumber: true } },
              },
            },
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
      take: 200,
    });

    return assignments.map((a) => ({
      id: a.id,
      serviceOrderId: a.serviceOrder.id,
      technicianName: a.technician.userAccount.fullName,
      employeeCode: a.technician.employeeCode,
      isPrimary: a.isPrimary,
      status: a.status,
      assignedAt: a.assignedAt.toISOString(),
      startedAt: a.startedAt?.toISOString() ?? null,
      endedAt: a.endedAt?.toISOString() ?? null,
      durationMinutes: a.startedAt && a.endedAt
        ? Math.round((a.endedAt.getTime() - a.startedAt.getTime()) / 60000)
        : null,
      customerName: a.serviceOrder.serviceVisit
        ? `${a.serviceOrder.serviceVisit.customer.firstName} ${a.serviceOrder.serviceVisit.customer.lastName}`
        : '',
      vehiclePlate: a.serviceOrder.serviceVisit?.vehicle.plateNumber ?? '',
    }));
  }
}
