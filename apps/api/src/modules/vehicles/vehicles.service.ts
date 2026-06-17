import {
  Injectable,
  NotFoundException,
  BadRequestException,
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
