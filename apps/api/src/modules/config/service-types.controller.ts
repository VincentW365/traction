import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@ApiTags('Service Types')
@Controller('service-types')
export class ServiceTypesController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List all active service types (public)' })
  async findAll() {
    return this.prisma.serviceType.findMany({
      where: { isActive: true },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        family: true,
        baseDurationMinutes: true,
        quickService: true,
        appointmentOnly: true,
        requiredSkillCode: true,
        requiredBayType: true,
        partsPrepositionRequired: true,
        transportEligible: true,
        batchingFamily: true,
      },
    });
  }

  @Get(':code')
  @ApiOperation({ summary: 'Get a single service type by code (public)' })
  @ApiParam({ name: 'code', description: 'Unique service type code' })
  async findByCode(@Param('code') code: string) {
    const serviceType = await this.prisma.serviceType.findUnique({
      where: { code },
      select: {
        id: true,
        code: true,
        name: true,
        family: true,
        baseDurationMinutes: true,
        quickService: true,
        appointmentOnly: true,
        requiredSkillCode: true,
        requiredBayType: true,
        partsPrepositionRequired: true,
        transportEligible: true,
        batchingFamily: true,
        isActive: true,
      },
    });

    if (!serviceType) {
      throw new NotFoundException(`Service type with code "${code}" not found`);
    }

    return serviceType;
  }
}
