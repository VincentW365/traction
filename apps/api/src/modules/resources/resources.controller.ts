import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ResourcesService } from './resources.service';
import { AssignResourceDto } from './dto/assign-resource.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@ApiTags('Resources')
@Controller('resources')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ResourcesController {
  constructor(
    private resourcesService: ResourcesService,
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Get('board')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  async getDispatchBoard(@Query('siteId') siteId: string) {
    return this.resourcesService.getDispatchBoard(siteId);
  }

  @Post(':id/assign')
  @RequirePermission(PERMISSIONS.QUEUE_OVERRIDE)
  async assignToResource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignResourceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.resourcesService.assignToResource(
      id,
      dto.queueTicketId,
      dto.technicianId ?? null,
      user.sub,
      { mobileJackOverride: dto.mobileJackOverride, overrideReason: dto.overrideReason },
    );
  }

  @Post(':id/release')
  @RequirePermission(PERMISSIONS.QUEUE_OVERRIDE)
  async releaseResource(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.resourcesService.releaseResource(id, user.sub);
  }

  @Get('reservations')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  async getReservations(
    @Query('siteId') siteId: string,
    @Query('date') date: string,
  ) {
    return this.resourcesService.getReservations(siteId, date);
  }

  // --- Admin CRUD ---

  @Get()
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'List all work resources for a site' })
  async listAll(@Query('siteId') siteId: string) {
    return this.prisma.workResource.findMany({
      where: { siteId },
      orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
    });
  }

  @Post()
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Create a new work resource' })
  async create(@Body() body: any, @CurrentUser() user: JwtPayload) {
    const resource = await this.prisma.workResource.create({ data: body });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'RESOURCE_CREATE',
      entityType: 'WorkResource',
      entityId: resource.id,
      afterJson: body,
    });
    return resource;
  }

  @Get(':id/operational-status')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get resource operational status' })
  async getOperationalStatus(@Param('id', ParseUUIDPipe) id: string) {
    const status = await this.prisma.resourceOperationalStatus.findUnique({
      where: { resourceId: id },
    });
    return status ?? { resourceId: id, isOperational: true, reason: null };
  }

  @Post(':id/operational-status')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({ summary: 'Set resource operational status (e.g., power wash machine up/down)' })
  async setOperationalStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { isOperational: boolean; reason?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const result = await this.prisma.resourceOperationalStatus.upsert({
      where: { resourceId: id },
      update: { isOperational: body.isOperational, reason: body.reason ?? null, setByUserId: user.sub },
      create: { resourceId: id, isOperational: body.isOperational, reason: body.reason ?? null, setByUserId: user.sub },
    });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'RESOURCE_OPERATIONAL_STATUS_CHANGE',
      entityType: 'ResourceOperationalStatus',
      entityId: result.id,
      afterJson: { resourceId: id, isOperational: body.isOperational, reason: body.reason },
    });
    return result;
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Update a work resource' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
    @CurrentUser() user: JwtPayload,
  ) {
    const existing = await this.prisma.workResource.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Resource ${id} not found`);

    const updated = await this.prisma.workResource.update({ where: { id }, data: body });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'RESOURCE_UPDATE',
      entityType: 'WorkResource',
      entityId: id,
      beforeJson: { code: existing.code, name: existing.name, isActive: existing.isActive },
      afterJson: body,
    });
    return updated;
  }
}
