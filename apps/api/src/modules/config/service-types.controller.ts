import { Controller, Get, Post, Patch, Body, Param, NotFoundException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CatalogueReadinessService } from './catalogue-readiness.service';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, type JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Service Types')
@Controller('service-types')
export class ServiceTypesController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private readiness: CatalogueReadinessService,
  ) {}

  /**
   * CR-2026-108 Stage 4B — the Catalogue Readiness Audit. READ-ONLY decision
   * support: which services are safe, understandable and operationally suitable
   * for customer self-service. It changes nothing; a person decides.
   */
  @Get('readiness')
  @UseGuards(JwtAuthGuard, RbacGuard)
  @ApiBearerAuth()
  @RequirePermission(PERMISSIONS.SERVICE_TYPE_MANAGE)
  @ApiOperation({ summary: 'Catalogue readiness audit for customer self-service booking (read-only)' })
  async catalogueReadiness() {
    return this.readiness.audit();
  }

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
        canUseOverflow: true,
        canUseLightSlot: true,
        requiresMileage: true,
        isExternal: true,
        requiresPowerWash: true,
        standPreferred: true,
        mobileJackAllowed: true,
        // CR-2026-108 Stage 4A — self-service booking configuration.
        bookableOnline: true,
        customerFacingName: true,
        bookingBufferMinutes: true,
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

  // --- Guarded CRUD endpoints (ADMIN/MANAGER) ---

  @Post()
  @UseGuards(JwtAuthGuard, RbacGuard)
  @ApiBearerAuth()
  @RequirePermission(PERMISSIONS.SERVICE_TYPE_MANAGE)
  @ApiOperation({ summary: 'Create a new service type' })
  async create(@Body() body: any, @CurrentUser() user: JwtPayload) {
    const st = await this.prisma.serviceType.create({ data: body });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'SERVICE_TYPE_CREATE',
      entityType: 'ServiceType',
      entityId: st.id,
      afterJson: body,
    });
    return st;
  }

  @Patch(':code')
  @UseGuards(JwtAuthGuard, RbacGuard)
  @ApiBearerAuth()
  @RequirePermission(PERMISSIONS.SERVICE_TYPE_MANAGE)
  @ApiOperation({ summary: 'Update a service type' })
  async update(@Param('code') code: string, @Body() body: any, @CurrentUser() user: JwtPayload) {
    const existing = await this.prisma.serviceType.findUnique({ where: { code } });
    if (!existing) throw new NotFoundException(`Service type "${code}" not found`);

    const updated = await this.prisma.serviceType.update({ where: { code }, data: body });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'SERVICE_TYPE_UPDATE',
      entityType: 'ServiceType',
      entityId: updated.id,
      beforeJson: { name: existing.name, baseDurationMinutes: existing.baseDurationMinutes, isActive: existing.isActive },
      afterJson: body,
    });
    return updated;
  }
}
