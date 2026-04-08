import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Search vehicles by plate number, VIN, or customer name.
   * Returns the first 20 matches with the customer relation included.
   */
  async search(query: string) {
    const term = query.trim();

    return this.prisma.vehicle.findMany({
      where: {
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

    // Auto-generate vehicleCode from plate: "SC-{PLATE}"
    const plateNormalized = data.plateNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const vehicleCode = `SC-${plateNormalized}`;

    return this.prisma.vehicle.create({
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
      },
      include: { customer: true },
    });
  }

  /**
   * Find a single vehicle by ID. Includes the customer relation.
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
      },
      include: { customer: true },
    });
  }

  /**
   * List all vehicles belonging to a specific customer.
   */
  async findByCustomer(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      throw new NotFoundException(
        `Customer with id ${customerId} not found`,
      );
    }

    return this.prisma.vehicle.findMany({
      where: { customerId },
      include: { customer: true },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
