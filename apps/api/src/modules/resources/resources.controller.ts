import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ResourcesService } from './resources.service';
import { ResourceTruthAuditService } from './resource-truth-audit.service';
import { ResourceAdminService, type ResourceWriteModel } from './resource-admin.service';
import { AssignResourceDto } from './dto/assign-resource.dto';
import { SetOperationalStatusDto } from './dto/set-operational-status.dto';
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
    private admin: ResourceAdminService,
    private prisma: PrismaService,
    private audit: AuditService,
    private readonly truthAuditService: ResourceTruthAuditService,
  ) {}

  /**
   * CR-2026-108 Stage 5A — the Resource Truth Audit. READ-ONLY: it proposes a
   * capacity classification for every resource and states what only management
   * can confirm. Nothing here becomes production capacity on its own.
   */
  @Get('truth-audit')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Resource truth audit — proposed capacity roles and what needs management confirmation (read-only)' })
  truthAudit() {
    return this.truthAuditService.audit();
  }

  /**
   * CR-2026-108 Stage 5B §6 — the reconciliation view. Two resource models exist;
   * this shows both sides with their link state so a person can pair them. It
   * merges nothing and deletes nothing.
   *
   * Declared above the parameterised routes so "reconciliation" is never parsed
   * as an id.
   */
  @Get('reconciliation')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Resource / legacy bay reconciliation — both inventories with link state' })
  reconciliation(@Query('siteId') siteId: string) {
    return this.admin.reconciliation(siteId);
  }

  @Get('board')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  async getDispatchBoard(@Query('siteId') siteId: string) {
    return this.resourcesService.getDispatchBoard(siteId);
  }

  @Get('overview')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({
    summary:
      'Unified dispatch overview: resources, technician load, needs-dispatch, blocked, QC & overdue (CR-2026-080)',
  })
  async getDispatchOverview(@Query('siteId') siteId: string) {
    return this.resourcesService.getDispatchOverview(siteId);
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
  @ApiOperation({ summary: 'Create a work resource or bay (validated, audited)' })
  async create(
    @Body() body: ResourceWriteModel & { siteId: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const { siteId, ...data } = body ?? ({} as never);
    return this.admin.create(siteId, data, user.sub);
  }

  @Get('overview-admin')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Operational counts for the Resources & Bays screen' })
  adminOverview(@Query('siteId') siteId: string) {
    return this.admin.overview(siteId);
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
  @RequirePermission(PERMISSIONS.RESOURCE_OPERATIONAL_TOGGLE)
  @ApiOperation({ summary: 'Set resource operational status (e.g., mark a bay/jack up/down)' })
  async setOperationalStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetOperationalStatusDto,
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
  @ApiOperation({ summary: 'Update a work resource (concurrency-guarded, audited)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResourceWriteModel & { expectedUpdatedAt?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const { expectedUpdatedAt, ...data } = body ?? ({} as never);
    return this.admin.update(id, data, user.sub, expectedUpdatedAt);
  }

  @Post(':id/status')
  @RequirePermission(PERMISSIONS.RESOURCE_OPERATIONAL_TOGGLE)
  @ApiOperation({ summary: 'Set graded operational status (maintenance, out of service, ...)' })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status: string; reason?: string; expectedReturnAt?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.admin.setStatus(id, body ?? ({} as never), user.sub);
  }

  /**
   * §8/§9 — replace the set of work kinds this physical position can take.
   * Capabilities describe versatility, not quantity: they never multiply capacity.
   */
  @Post(':id/capabilities')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Set which kinds of work this resource can take (replaces the set, audited)' })
  setCapabilities(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { capabilities?: string[] },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.admin.setCapabilities(id, body?.capabilities ?? [], user.sub);
  }

  /**
   * §5 — link this resource to the legacy bay it represents, or send
   * `legacyBayId: null` to unlink. Manual and explicit; never inferred from codes.
   */
  @Post(':id/legacy-bay')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Link or unlink the legacy WorkBay this resource represents (audited)' })
  linkLegacyBay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { legacyBayId?: string | null },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.admin.linkLegacyBay(id, body?.legacyBayId ?? null, user.sub);
  }

  @Post(':id/retire')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Retire a resource permanently. History is kept; new work is refused.' })
  retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.admin.retire(id, body?.reason ?? '', user.sub);
  }

  @Post(':id/reactivate')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Bring a retired resource back into service' })
  reactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.admin.reactivate(id, user.sub);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Delete a never-used resource. Anything with history must be retired instead.' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.admin.deleteIfUnused(id, user.sub);
  }

  @Get(':id/impact')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'What a change to this resource would affect (for pre-save warnings)' })
  impact(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.impact(id);
  }

  @Get(':id/history')
  @RequirePermission(PERMISSIONS.RESOURCE_MANAGE)
  @ApiOperation({ summary: 'Change history for a resource, from the audit log' })
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.history(id);
  }
}
