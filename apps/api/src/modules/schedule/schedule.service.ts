import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { liveVisitWhere, serviceVisitIsLive } from '../../common/helpers/operational-scope';

/**
 * Read-only aggregation service for the operational schedule UI.
 * Does NOT introduce new write paths — all mutations go through existing services.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Get full day schedule: resources, events, queue rail items, pickup items, stats.
   */
  async getDaySchedule(siteId: string, date: string) {
    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayEnd = new Date(`${date}T23:59:59Z`);

    // 1. Operating hours for this day
    const operatingHours = await this.getOperatingHours(siteId, date);

    // 2. Resources grouped by category
    const resources = await this.prisma.workResource.findMany({
      where: { siteId, isActive: true },
      orderBy: { displayOrder: 'asc' },
    });

    // 3. Reservations for this date
    const reservations = await this.prisma.resourceReservation.findMany({
      where: {
        siteId,
        reservedFrom: { lte: dayEnd },
        reservedUntil: { gte: dayStart },
        status: { in: ['PENDING', 'ACTIVE'] },
      },
      include: {
        appointment: {
          include: {
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true } },
            services: { include: { serviceType: { select: { name: true } } } },
          },
        },
        resource: { select: { id: true, code: true } },
      },
    });

    // 4. Active occupancies (OCCUPIED resources)
    const occupancies = await this.prisma.resourceOccupancy.findMany({
      where: {
        status: 'OCCUPIED',
        resource: { siteId },
      },
      include: {
        resource: { select: { id: true, code: true } },
        serviceVisit: {
          include: {
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true } },
            queueTicket: { select: { ticketNumber: true } },
            appointment: {
              include: { services: { include: { serviceType: { select: { name: true } } } } },
            },
          },
        },
      },
    });

    // 5. Completed visits today (for muted timeline display)
    // CR-2026-006: always exclude HISTORICAL_IMPORT visits (no opt-in on live
    // schedule). Real leak — historical CLOSED visits have a recent updatedAt
    // from import and would otherwise appear as completed on today's timeline.
    const completedVisits = await this.prisma.serviceVisit.findMany({
      where: {
        siteId,
        status: { in: ['READY_FOR_PICKUP', 'CLOSED'] },
        updatedAt: { gte: dayStart, lte: dayEnd },
        ...liveVisitWhere(false),
      },
      include: {
        customer: { select: { firstName: true, lastName: true } },
        vehicle: { select: { plateNumber: true } },
        queueTicket: { select: { ticketNumber: true } },
        appointment: {
          include: { services: { include: { serviceType: { select: { name: true } } } } },
        },
        resourceOccupancies: { include: { resource: { select: { id: true, code: true } } } },
      },
    });

    // 6. Queue items (NOT on timeline — queue rail only)
    const queueTickets = await this.prisma.queueTicket.findMany({
      where: {
        serviceVisit: {
          siteId,
          status: { in: ['CHECKED_IN', 'QUEUED'] },
          ...serviceVisitIsLive(), // CR-2026-006: historical visits have no ticket; defense-in-depth
        },
        displayStatus: { in: ['PENDING_RANK', 'WAITING', 'BLOCKED'] },
      },
      include: {
        serviceVisit: {
          include: {
            customer: { select: { firstName: true, lastName: true } },
            vehicle: { select: { plateNumber: true, weightClass: true } },
            appointment: {
              include: { services: { include: { serviceType: { select: { name: true, requiredBayType: true } } } } },
            },
          },
        },
      },
      orderBy: { queueRank: { sort: 'asc', nulls: 'last' } },
    });

    // 7. Ready for pickup
    // CR-2026-006: always live (historical visits are terminal CLOSED, so the
    // status filter already excludes them — added for consistency/defense).
    const readyForPickup = await this.prisma.serviceVisit.findMany({
      where: { siteId, status: 'READY_FOR_PICKUP', ...liveVisitWhere(false) },
      include: {
        customer: { select: { firstName: true, lastName: true, phone: true, email: true } },
        vehicle: { select: { plateNumber: true } },
        queueTicket: { select: { ticketNumber: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // 7b. Walk-in visits checked in today — shown on the Appointments calendar at
    // their ARRIVAL time (walk-ins have no scheduled slot). Live, non-test-data
    // only. Placed after completedVisits/readyForPickup so the scope test (which
    // asserts serviceVisit.findMany[0]) keeps pointing at completedVisits.
    const walkInVisits = await this.prisma.serviceVisit.findMany({
      where: {
        siteId,
        sourceType: 'WALKIN',
        checkedInAt: { gte: dayStart, lte: dayEnd },
        testDataRunId: null,
      },
      include: {
        customer: { select: { firstName: true, lastName: true } },
        vehicle: { select: { plateNumber: true } },
        queueTicket: { select: { id: true, ticketNumber: true } },
      },
      orderBy: { checkedInAt: 'asc' },
    });

    // 8. Technician assignments for today
    const assignments = await this.prisma.technicianAssignment.findMany({
      where: {
        assignedAt: { gte: dayStart, lte: dayEnd },
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
      },
      include: {
        technician: {
          include: { userAccount: { select: { fullName: true } } },
        },
      },
    });
    const techByServiceOrder = new Map(
      assignments.map((a) => [a.serviceOrderId, a.technician.userAccount.fullName]),
    );

    // --- Map into unified response ---

    const events: ScheduleEvent[] = [];

    // Reservations → RESERVATION events
    for (const r of reservations) {
      const appt = r.appointment;
      events.push({
        id: `res-${r.id}`,
        resourceId: r.resourceId,
        type: 'RESERVATION',
        startTime: r.reservedFrom.toISOString(),
        endTime: r.reservedUntil.toISOString(),
        ticketNumber: null,
        customerName: `${appt.customer.firstName} ${appt.customer.lastName}`,
        vehiclePlate: appt.vehicle.plateNumber,
        services: appt.services.map((s) => s.serviceType.name).join(', '),
        sourceType: 'APPOINTMENT',
        status: r.status,
        technicianName: null,
      });
    }

    // Active occupancies → ACTIVE_WORK events
    for (const occ of occupancies) {
      const sv = occ.serviceVisit;
      if (!sv) continue;
      const services = sv.appointment?.services?.map((s) => s.serviceType.name).join(', ') ?? 'Walk-in service';
      events.push({
        id: `occ-${occ.id}`,
        resourceId: occ.resource.id,
        type: sv.partsReadiness === 'REQUIRED_NOT_READY' ? 'BLOCKED' : 'ACTIVE_WORK',
        startTime: occ.occupiedAt.toISOString(),
        endTime: occ.expectedEndAt?.toISOString() ?? null,
        ticketNumber: sv.queueTicket?.ticketNumber ?? null,
        customerName: `${sv.customer.firstName} ${sv.customer.lastName}`,
        vehiclePlate: sv.vehicle.plateNumber,
        services,
        sourceType: sv.sourceType,
        status: sv.status,
        technicianName: null, // filled below if available
      });
    }

    // Completed visits → COMPLETED events (muted)
    for (const sv of completedVisits) {
      const lastOcc = sv.resourceOccupancies?.[0];
      if (!lastOcc) continue; // skip if never assigned to a resource
      const services = sv.appointment?.services?.map((s) => s.serviceType.name).join(', ') ?? 'Walk-in service';
      events.push({
        id: `done-${sv.id}`,
        resourceId: lastOcc.resource.id,
        type: 'COMPLETED',
        startTime: lastOcc.occupiedAt.toISOString(),
        endTime: sv.updatedAt.toISOString(),
        ticketNumber: sv.queueTicket?.ticketNumber ?? null,
        customerName: `${sv.customer.firstName} ${sv.customer.lastName}`,
        vehiclePlate: sv.vehicle.plateNumber,
        services,
        sourceType: sv.sourceType,
        status: sv.status,
        technicianName: null,
      });
    }

    // Map queue tickets into rail items
    const queueItems: QueueRailItem[] = queueTickets.map((t) => {
      const sv = t.serviceVisit;
      const services = sv.appointment?.services?.map((s) => s.serviceType.name).join(', ') ?? 'Walk-in service';
      const requiredTypes = (sv.appointment?.services?.map((s) => s.serviceType.requiredBayType).filter((t): t is string => t !== null) ?? []);
      return {
        ticketId: t.id,
        serviceVisitId: sv.id,
        ticketNumber: t.ticketNumber,
        customerName: `${sv.customer.firstName} ${sv.customer.lastName}`,
        customerId: sv.customerId,
        vehiclePlate: sv.vehicle.plateNumber,
        vehicleId: sv.vehicleId,
        vehicleWeightClass: sv.vehicle.weightClass,
        services,
        sourceType: sv.sourceType,
        waitMinutes: sv.checkedInAt ? Math.round((Date.now() - new Date(sv.checkedInAt).getTime()) / 60000) : 0,
        partsReadiness: sv.partsReadiness,
        readyForDispatch: t.readyForDispatch,
        blockedReason: t.blockedReason,
        fifoPosition: t.queueRank,
        displayStatus: t.displayStatus,
        requiredResourceTypes: [...new Set(requiredTypes)],
      };
    });

    // Map ready for pickup
    const pickupItems = readyForPickup.map((sv) => ({
      serviceVisitId: sv.id,
      ticketNumber: sv.queueTicket?.ticketNumber ?? 'N/A',
      customerName: `${sv.customer.firstName} ${sv.customer.lastName}`,
      customerPhone: sv.customer.phone,
      customerEmail: sv.customer.email,
      vehiclePlate: sv.vehicle.plateNumber,
    }));

    // Walk-in blocks for the Appointments calendar (placed by arrival time).
    const walkIns = walkInVisits.map((sv) => ({
      serviceVisitId: sv.id,
      ticketId: sv.queueTicket?.id ?? null,
      ticketNumber: sv.queueTicket?.ticketNumber ?? null,
      customerName: `${sv.customer.firstName} ${sv.customer.lastName}`,
      vehiclePlate: sv.vehicle.plateNumber,
      checkedInAt: sv.checkedInAt ? sv.checkedInAt.toISOString() : null,
      status: sv.status,
    }));

    // Stats
    const todayAppointments = await this.prisma.appointment.count({
      where: { siteId, scheduledStartAt: { gte: dayStart, lte: dayEnd } },
    });
    // Count all walk-ins that checked in today (matches the calendar), not just
    // those still queued.
    const walkInCount = walkIns.length;
    const blockedCount = queueTickets.filter((t) => t.displayStatus === 'BLOCKED').length;

    return {
      siteId,
      date,
      operatingHours,
      resources: resources.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        category: r.resourceCategory as string,
        maxWeight: r.maxVehicleWeight,
        liftType: r.liftType,
        hasAlignment: r.hasAlignment,
        hasDiagnostics: r.hasDiagnostics,
        capabilities: [
          r.liftType ? `${r.liftType} lift` : null,
          r.hasAlignment ? 'alignment' : null,
          r.hasDiagnostics ? 'diagnostics' : null,
        ].filter(Boolean) as string[],
        status: 'AVAILABLE', // default; overridden by occupancy data in events
      })),
      events,
      queueItems,
      walkIns,
      readyForPickup: pickupItems,
      stats: {
        appointments: todayAppointments,
        walkIns: walkInCount,
        completed: completedVisits.length,
        blocked: blockedCount,
      },
    };
  }

  /**
   * Get week capacity summary.
   */
  async getWeekSchedule(siteId: string, weekStart: string) {
    const startDate = new Date(`${weekStart}T00:00:00Z`);
    const days: WeekDayData[] = [];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayStr = new Date().toISOString().split('T')[0];

    const resourceCount = await this.prisma.workResource.count({
      where: { siteId, isActive: true },
    });

    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      const dayStart = new Date(`${dateStr}T00:00:00Z`);
      const dayEnd = new Date(`${dateStr}T23:59:59Z`);
      const dayOfWeek = d.getDay();

      const operatingHours = await this.getOperatingHours(siteId, dateStr);

      const [appointmentCount, completedCount, blockedCount] = await Promise.all([
        this.prisma.appointment.count({
          where: { siteId, scheduledStartAt: { gte: dayStart, lte: dayEnd } },
        }),
        this.prisma.serviceVisit.count({
          // CR-2026-006: always exclude HISTORICAL_IMPORT (recent import updatedAt
          // would otherwise inflate the week's completed count).
          where: {
            siteId,
            status: { in: ['READY_FOR_PICKUP', 'CLOSED'] },
            updatedAt: { gte: dayStart, lte: dayEnd },
            ...liveVisitWhere(false),
          },
        }),
        this.prisma.queueTicket.count({
          where: {
            serviceVisit: { siteId },
            displayStatus: 'BLOCKED',
            generatedAt: { gte: dayStart, lte: dayEnd },
          },
        }),
      ]);

      // Simple utilization estimate: appointments / (resources * operating hours slots)
      let utilization = 0;
      if (operatingHours && resourceCount > 0) {
        const [openH, openM] = operatingHours.open.split(':').map(Number);
        const [closeH, closeM] = operatingHours.close.split(':').map(Number);
        const totalSlots = Math.floor(((closeH * 60 + closeM) - (openH * 60 + openM)) / 30) * resourceCount;
        utilization = totalSlots > 0 ? Math.min(100, Math.round((appointmentCount * 2 / totalSlots) * 100)) : 0;
      }

      days.push({
        date: dateStr,
        dayName: dayNames[dayOfWeek],
        operatingHours,
        appointmentCount,
        walkInCount: 0, // walk-ins only known on current day
        completedCount,
        blockedCount,
        resourceUtilization: utilization,
        isToday: dateStr === todayStr,
        isClosed: operatingHours === null,
      });
    }

    return { siteId, weekStart, days };
  }

  private async getOperatingHours(siteId: string, date: string): Promise<{ open: string; close: string } | null> {
    const rule = await this.prisma.businessRuleConfig.findFirst({
      where: { siteId, ruleKey: 'operating_hours' },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (!rule) return { open: '08:00', close: '17:00' }; // fallback

    const config = rule.valueJson as { schedule: Record<string, { open: string; close: string }> };
    const dayOfWeek = new Date(`${date}T12:00:00Z`).getDay().toString();
    const dayHours = config?.schedule?.[dayOfWeek];
    return dayHours ?? null; // null = closed
  }
}

// Types — exported for controller return type inference
export interface ScheduleEvent {
  id: string;
  resourceId: string | null;
  type: 'RESERVATION' | 'ACTIVE_WORK' | 'BLOCKED' | 'COMPLETED';
  startTime: string;
  endTime: string | null;
  ticketNumber: string | null;
  customerName: string;
  vehiclePlate: string;
  services: string;
  sourceType: string;
  status: string;
  technicianName: string | null;
}

export interface QueueRailItem {
  ticketId: string;
  serviceVisitId: string;
  ticketNumber: string;
  customerName: string;
  customerId: string;
  vehiclePlate: string;
  vehicleId: string;
  vehicleWeightClass: string | null;
  services: string;
  sourceType: string;
  waitMinutes: number;
  partsReadiness: string;
  readyForDispatch: boolean;
  blockedReason: string | null;
  fifoPosition: number | null;
  displayStatus: string;
  requiredResourceTypes: string[];
}

export interface WeekDayData {
  date: string;
  dayName: string;
  operatingHours: { open: string; close: string } | null;
  appointmentCount: number;
  walkInCount: number;
  completedCount: number;
  blockedCount: number;
  resourceUtilization: number;
  isToday: boolean;
  isClosed: boolean;
}
