import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { liveVehicleWhere } from '../../common/helpers/operational-scope';
import { normalizeCodeQuery } from '../../common/helpers/normalize-code-query';
import { ClassificationService } from './classification.service';

@Injectable()
export class VehiclesService {
  constructor(
    private prisma: PrismaService,
    private readonly classification: ClassificationService,
  ) {}

  /**
   * Search vehicles by plate number, VIN, or customer name.
   * Returns the first 20 matches with the customer relation included.
   *
   * CR-2026-006: placeholder vehicles (vehicleCode starts 'HIST-UNRESOLVED-')
   * are excluded by default. Pass includeHistorical=true to surface them
   * (gated by the route's existing RBAC).
   */
  async search(query: string, includeHistorical = false) {
    const term = query.trim();
    // CR-2026-027: separator-insensitive code match ('SC-1211KC'/'1211KC' → 'SC1211KC').
    const codeTerm = normalizeCodeQuery(term);

    return this.prisma.vehicle.findMany({
      where: {
        AND: [
          {
            OR: [
              { plateNumber: { contains: term, mode: 'insensitive' } },
              { vehicleCode: { contains: term, mode: 'insensitive' } },
              { vin: { contains: term, mode: 'insensitive' } },
              {
                customer: {
                  OR: [
                    { firstName: { contains: term, mode: 'insensitive' } },
                    { lastName: { contains: term, mode: 'insensitive' } },
                  ],
                },
              },
              ...(codeTerm.length >= 2
                ? [{ vehicleCode: { contains: codeTerm, mode: 'insensitive' as const } }]
                : []),
            ],
          },
          liveVehicleWhere(includeHistorical),
        ],
      },
      include: { customer: true },
      take: 20,
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Create a new vehicle linked to an existing customer.
   * Validates that the referenced customer exists before creation.
   */
  async create(data: CreateVehicleDto) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: data.customerId },
    });

    if (!customer) {
      throw new BadRequestException(
        `Customer with id ${data.customerId} does not exist`,
      );
    }

    // Auto-generate vehicleCode from plate: "SC{PLATE}" (matches SharePoint Title; CR-2026-027)
    const plateNormalized = data.plateNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const vehicleCode = `SC${plateNormalized}`;

    const created = await this.prisma.vehicle.create({
      data: {
        customerId: data.customerId,
        vehicleCode,
        plateNumber: data.plateNumber,
        vin: data.vin ?? null,
        make: data.make ?? null,
        model: data.model ?? null,
        modelYear: data.modelYear ?? null,
        color: data.color ?? null,
        odometer: data.odometer ?? null,
        transmission: data.transmission ?? null,
        drivetrain: data.drivetrain ?? null,
        fuelType: data.fuelType ?? null,
        engineNo: data.engineNo ?? null,
        driveSide: data.driveSide ?? null,
      },
      include: { customer: true },
    });

    // CR-2026-038 — auto-classify from make/model (confident matches only; low/none
    // stay unclassified for the small needs-review list). System actor (no user ctx).
    const auto = await this.classification.autoClassify(created.id, null);
    if (auto.applied && auto.serviceClass) created.serviceClass = auto.serviceClass;

    return created;
  }

  /**
   * Find a single vehicle by ID. Includes the customer relation.
   *
   * CR-2026-006 exemption: by-id lookup is intentional — the caller asked for
   * that exact record (including a historical placeholder vehicle), so no
   * operational-scope filter is applied here.
   */
  async findById(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
      include: { customer: true },
    });

    if (!vehicle) {
      throw new NotFoundException(`Vehicle with id ${id} not found`);
    }

    return vehicle;
  }

  /**
   * CR-2026-102 — the technician-safe, read-only vehicle view.
   *
   * CONTEXTUAL authorization, not directory permission: a technician may read
   * the operational record of a vehicle they have (or have had) an assignment
   * on — never browse the fleet. Advisors/managers pass through (their
   * directory access is broader anyway). The payload is a read model: vehicle
   * facts, the customer SUMMARY (name/phone — context, not a gateway), the
   * current live visit with its jobs and inspections, and the vehicle's
   * previous service history. Nothing in it is writable.
   */
  async getTechnicianView(vehicleId: string, user: { sub: string; role: string }) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        id: true,
        vehicleCode: true,
        plateNumber: true,
        vin: true,
        make: true,
        model: true,
        modelYear: true,
        color: true,
        odometer: true,
        serviceClass: true,
        weightClass: true,
        fuelType: true,
        transmission: true,
        drivetrain: true,
        engineNo: true,
        driveSide: true,
        customer: { select: { firstName: true, lastName: true, phone: true, notes: true } },
      },
    });
    if (!vehicle) throw new NotFoundException(`Vehicle with id ${vehicleId} not found`);

    // §2 — contextual gate for technicians: this vehicle must be on THEIR work.
    if (user.role === 'TECHNICIAN') {
      const tech = await this.prisma.technician.findUnique({
        where: { userAccountId: user.sub },
        select: { id: true },
      });
      const association = tech
        ? await this.prisma.technicianAssignment.findFirst({
            where: {
              technicianId: tech.id,
              serviceOrder: { serviceVisit: { vehicleId } },
            },
            select: { id: true },
          })
        : null;
      if (!association) {
        throw new ForbiddenException(
          'This vehicle is not on your work. Open vehicles from your assigned jobs.',
        );
      }
    }

    const TERMINAL = ['CLOSED', 'ABANDONED', 'CANCELLED'];
    const currentVisitRow = await this.prisma.serviceVisit.findFirst({
      where: {
        vehicleId,
        status: { notIn: TERMINAL as never[] },
        sourceType: { not: 'HISTORICAL_IMPORT' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        visitNumber: true,
        status: true,
        sourceType: true,
        checkedInAt: true,
        mileageIn: true,
        notes: true,
        appointment: { select: { scheduledStartAt: true, notes: true } },
        queueTicket: { select: { id: true, ticketNumber: true } },
        serviceOrders: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            status: true,
            notes: true,
            items: { select: { serviceType: { select: { name: true } } } },
            assignments: {
              where: { endedAt: null },
              select: {
                technician: {
                  select: { employeeCode: true, userAccount: { select: { fullName: true } } },
                },
              },
            },
          },
        },
        inspections: {
          select: { id: true, inspectionNumber: true, status: true, kind: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    // Previous visits — same shape as the job workspace's history (CR-2026-101).
    const historyRows = await this.prisma.serviceVisit.findMany({
      where: { vehicleId, ...(currentVisitRow ? { id: { not: currentVisitRow.id } } : {}) },
      select: {
        id: true,
        visitNumber: true,
        sourceType: true,
        status: true,
        checkedInAt: true,
        createdAt: true,
        mileageIn: true,
        notes: true,
        serviceOrders: {
          select: {
            status: true,
            items: { select: { serviceType: { select: { name: true } } } },
            reworks: { select: { id: true } },
            pauses: { where: { reasonCode: 'WAITING_PARTS' }, select: { id: true } },
          },
        },
        inspections: {
          select: {
            id: true,
            inspectionNumber: true,
            status: true,
            createdAt: true,
            comments: true,
            recommendations: {
              select: { severity: true, description: true, customerDecision: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    return {
      vehicle: {
        id: vehicle.id,
        vehicleCode: vehicle.vehicleCode,
        plateNumber: vehicle.plateNumber,
        vin: vehicle.vin,
        make: vehicle.make,
        model: vehicle.model,
        modelYear: vehicle.modelYear,
        color: vehicle.color,
        odometer: vehicle.odometer,
        serviceClass: vehicle.serviceClass,
        weightClass: vehicle.weightClass,
        fuelType: vehicle.fuelType,
        transmission: vehicle.transmission,
        drivetrain: vehicle.drivetrain,
        engineNo: vehicle.engineNo,
        driveSide: vehicle.driveSide,
      },
      // The customer SUMMARY (§5): job context, never a directory gateway.
      customer: {
        name: `${vehicle.customer.firstName} ${vehicle.customer.lastName}`,
        phone: vehicle.customer.phone,
        serviceNotes: vehicle.customer.notes,
      },
      currentVisit: currentVisitRow
        ? {
            serviceVisitId: currentVisitRow.id,
            visitNumber: currentVisitRow.visitNumber ?? null,
            status: currentVisitRow.status,
            sourceType: currentVisitRow.sourceType,
            checkedInAt: currentVisitRow.checkedInAt,
            mileageIn: currentVisitRow.mileageIn,
            // The stated reason for the visit (§6).
            concern: currentVisitRow.appointment?.notes ?? currentVisitRow.notes ?? null,
            appointmentAt: currentVisitRow.appointment?.scheduledStartAt ?? null,
            queueTicketId: currentVisitRow.queueTicket?.id ?? null,
            ticketNumber: currentVisitRow.queueTicket?.ticketNumber ?? null,
            jobs: currentVisitRow.serviceOrders.map((o) => ({
              orderId: o.id,
              status: o.status,
              advisorNotes: o.notes,
              services: o.items.map((i) => i.serviceType.name),
              technicians: o.assignments.map(
                (a) => a.technician.userAccount?.fullName ?? a.technician.employeeCode,
              ),
            })),
            inspections: currentVisitRow.inspections,
          }
        : null,
      history: historyRows.map((v) => ({
        serviceVisitId: v.id,
        visitNumber: v.visitNumber ?? null,
        sourceType: v.sourceType,
        status: v.status,
        date: v.checkedInAt ?? v.createdAt,
        mileageIn: v.mileageIn,
        notes: v.notes,
        services: v.serviceOrders.flatMap((o) => o.items.map((i) => i.serviceType.name)),
        hadRework: v.serviceOrders.some((o) => o.reworks.length > 0),
        hadPartsWait: v.serviceOrders.some((o) => o.pauses.length > 0),
        inspections: v.inspections.map((i) => ({
          id: i.id,
          inspectionNumber: i.inspectionNumber,
          status: i.status,
          date: i.createdAt,
          comments: i.comments,
          recommendations: i.recommendations,
        })),
      })),
    };
  }

  /**
   * Partial update of a vehicle. Cannot change the owning customer.
   */
  async update(id: string, data: UpdateVehicleDto) {
    // Ensure the vehicle exists before attempting update
    await this.findById(id);

    return this.prisma.vehicle.update({
      where: { id },
      data: {
        ...(data.plateNumber !== undefined && { plateNumber: data.plateNumber }),
        ...(data.vin !== undefined && { vin: data.vin }),
        ...(data.make !== undefined && { make: data.make }),
        ...(data.model !== undefined && { model: data.model }),
        ...(data.modelYear !== undefined && { modelYear: data.modelYear }),
        ...(data.color !== undefined && { color: data.color }),
        ...(data.odometer !== undefined && { odometer: data.odometer }),
        ...(data.transmission !== undefined && { transmission: data.transmission }),
        ...(data.drivetrain !== undefined && { drivetrain: data.drivetrain }),
        ...(data.fuelType !== undefined && { fuelType: data.fuelType }),
        ...(data.engineNo !== undefined && { engineNo: data.engineNo }),
        ...(data.driveSide !== undefined && { driveSide: data.driveSide }),
      },
      include: { customer: true },
    });
  }

  /**
   * List all vehicles belonging to a specific customer.
   *
   * CR-2026-006: placeholder vehicles are excluded by default. When viewing the
   * historical placeholder customer intentionally, pass includeHistorical=true.
   */
  async findByCustomer(customerId: string, includeHistorical = false) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      throw new NotFoundException(
        `Customer with id ${customerId} not found`,
      );
    }

    return this.prisma.vehicle.findMany({
      where: { customerId, ...liveVehicleWhere(includeHistorical) },
      include: { customer: true },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
