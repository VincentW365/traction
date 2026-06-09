import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateAvailabilityDto } from './dto/create-availability.dto';
import { BulkAvailabilityDto } from './dto/bulk-availability.dto';

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findByRange(filters: {
    siteId: string;
    startDate: string;
    endDate: string;
    technicianIds?: string[];
  }) {
    const where: any = {
      date: {
        gte: new Date(filters.startDate),
        lte: new Date(filters.endDate),
      },
      technician: {
        homeSiteId: filters.siteId,
      },
    };

    if (filters.technicianIds && filters.technicianIds.length > 0) {
      where.technicianId = { in: filters.technicianIds };
    }

    return this.prisma.mechanicDayAvailability.findMany({
      where,
      include: {
        technician: {
          select: {
            id: true,
            employeeCode: true,
            userAccount: {
              select: { fullName: true },
            },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { technician: { employeeCode: 'asc' } }],
    });
  }

  async upsert(dto: CreateAvailabilityDto, actorUserId: string) {
    const dateVal = new Date(dto.date);

    const result = await this.prisma.mechanicDayAvailability.upsert({
      where: {
        technicianId_date: {
          technicianId: dto.technicianId,
          date: dateVal,
        },
      },
      update: {
        shiftStart: dto.shiftStart,
        shiftEnd: dto.shiftEnd,
        status: dto.status ?? 'AVAILABLE',
        notes: dto.notes,
      },
      create: {
        technicianId: dto.technicianId,
        date: dateVal,
        shiftStart: dto.shiftStart,
        shiftEnd: dto.shiftEnd,
        status: dto.status ?? 'AVAILABLE',
        notes: dto.notes,
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'AVAILABILITY_SET',
      entityType: 'MechanicDayAvailability',
      entityId: result.id,
      afterJson: {
        technicianId: dto.technicianId,
        date: dto.date,
        shiftStart: dto.shiftStart,
        shiftEnd: dto.shiftEnd,
        status: dto.status,
      },
    });

    return result;
  }

  async update(id: string, data: Partial<CreateAvailabilityDto>, actorUserId: string) {
    const existing = await this.prisma.mechanicDayAvailability.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Availability record ${id} not found`);
    }

    const updateData: any = {};
    if (data.shiftStart) updateData.shiftStart = data.shiftStart;
    if (data.shiftEnd) updateData.shiftEnd = data.shiftEnd;
    if (data.status) updateData.status = data.status;
    if (data.notes !== undefined) updateData.notes = data.notes;

    const result = await this.prisma.mechanicDayAvailability.update({
      where: { id },
      data: updateData,
    });

    await this.audit.log({
      actorUserId,
      action: 'AVAILABILITY_UPDATE',
      entityType: 'MechanicDayAvailability',
      entityId: id,
      beforeJson: { shiftStart: existing.shiftStart, shiftEnd: existing.shiftEnd, status: existing.status },
      afterJson: updateData,
    });

    return result;
  }

  async remove(id: string, actorUserId: string) {
    const existing = await this.prisma.mechanicDayAvailability.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Availability record ${id} not found`);
    }

    await this.prisma.mechanicDayAvailability.delete({ where: { id } });

    await this.audit.log({
      actorUserId,
      action: 'AVAILABILITY_DELETE',
      entityType: 'MechanicDayAvailability',
      entityId: id,
      beforeJson: {
        technicianId: existing.technicianId,
        date: existing.date,
        status: existing.status,
      },
    });

    return { deleted: true };
  }

  async bulkSet(dto: BulkAvailabilityDto, actorUserId: string) {
    const results = [];
    for (const day of dto.days) {
      const result = await this.upsert(
        {
          technicianId: dto.technicianId,
          date: day.date,
          shiftStart: day.shiftStart,
          shiftEnd: day.shiftEnd,
          status: day.status,
          notes: day.notes,
        },
        actorUserId,
      );
      results.push(result);
    }
    return results;
  }
}
