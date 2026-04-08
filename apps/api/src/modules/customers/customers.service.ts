import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { Customer } from '@prisma/client';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Search customers by phone, name, or customer_number.
   * Case-insensitive partial match. Returns first 20 results.
   */
  async search(query: string): Promise<Customer[]> {
    return this.prisma.customer.findMany({
      where: {
        OR: [
          { phone: { contains: query, mode: 'insensitive' } },
          { firstName: { contains: query, mode: 'insensitive' } },
          { lastName: { contains: query, mode: 'insensitive' } },
          { customerNumber: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
          { vehicles: { some: { plateNumber: { contains: query, mode: 'insensitive' } } } },
          { vehicles: { some: { vehicleCode: { contains: query, mode: 'insensitive' } } } },
          { vehicles: { some: { vin: { contains: query, mode: 'insensitive' } } } },
        ],
      },
      take: 20,
      orderBy: { lastName: 'asc' },
    });
  }

  /**
   * Create a new customer with an auto-generated customer_number.
   * Uses a transaction with raw SQL to safely generate the next sequence value.
   * Format: CUST-000001, CUST-000002, etc.
   */
  async create(data: CreateCustomerDto): Promise<Customer> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<{ next_val: number }[]>`
        SELECT COALESCE(
          MAX(CAST(SUBSTRING(customer_number FROM 6) AS INTEGER)), 0
        ) + 1 AS next_val
        FROM customers
      `;

      const nextVal = result[0].next_val;
      const customerNumber = `CUST-${String(nextVal).padStart(6, '0')}`;

      return tx.customer.create({
        data: {
          customerNumber,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          email: data.email,
          notificationOptInSms: data.notificationOptInSms ?? true,
          notificationOptInEmail: data.notificationOptInEmail ?? true,
          notes: data.notes,
        },
      });
    });
  }

  /**
   * Find a customer by ID, including their vehicles.
   * Throws NotFoundException if not found.
   */
  async findById(id: string): Promise<Customer & { vehicles: unknown[] }> {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: { vehicles: true },
    });

    if (!customer) {
      throw new NotFoundException(`Customer with id "${id}" not found`);
    }

    return customer;
  }

  /**
   * Partial update of a customer record.
   * Throws NotFoundException if the customer does not exist.
   */
  async update(id: string, data: UpdateCustomerDto): Promise<Customer> {
    // Verify existence first for a clear 404
    const existing = await this.prisma.customer.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Customer with id "${id}" not found`);
    }

    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(data.firstName !== undefined && { firstName: data.firstName }),
        ...(data.lastName !== undefined && { lastName: data.lastName }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.notificationOptInSms !== undefined && {
          notificationOptInSms: data.notificationOptInSms,
        }),
        ...(data.notificationOptInEmail !== undefined && {
          notificationOptInEmail: data.notificationOptInEmail,
        }),
        ...(data.notes !== undefined && { notes: data.notes }),
      },
    });
  }
}
