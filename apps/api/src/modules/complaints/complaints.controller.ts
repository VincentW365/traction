import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { ComplaintsService } from './complaints.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import { UpdateComplaintDto } from './dto/update-complaint.dto';
import { ResolveComplaintDto } from './dto/resolve-complaint.dto';
import { AcknowledgeComplaintDto } from './dto/acknowledge-complaint.dto';
import { ComplaintQueryDto } from './dto/complaint-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { SiteGuard } from '../../common/guards/site.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, type JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

/**
 * CR-2026-032 — Customer Complaints Log.
 * Class guards: JwtAuthGuard + RbacGuard. SiteGuard on create (siteId in body);
 * by-id ops re-check siteId in the service (SiteGuard is a no-op there).
 */
@ApiTags('Complaints')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('complaints')
export class ComplaintsController {
  constructor(private readonly service: ComplaintsService) {}

  @Post()
  @UseGuards(SiteGuard)
  @RequirePermission(PERMISSIONS.COMPLAINT_CREATE)
  @ApiOperation({ summary: 'Log a new customer complaint' })
  @ApiCreatedResponse({ description: 'Complaint created (OPEN)' })
  create(@Body() dto: CreateComplaintDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user);
  }

  @Get()
  @RequirePermission(PERMISSIONS.COMPLAINT_VIEW)
  @ApiOperation({ summary: 'List complaints (site-scoped; filter by status/severity/type/customer)' })
  @ApiOkResponse({ description: 'Paginated complaints' })
  list(@Query() query: ComplaintQueryDto, @CurrentUser() user: JwtPayload) {
    return this.service.list(query, user);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.COMPLAINT_VIEW)
  @ApiOperation({ summary: 'Complaint detail + status timeline' })
  findById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findById(id, user);
  }

  @Post(':id/acknowledge')
  @RequirePermission(PERMISSIONS.COMPLAINT_MANAGE)
  @ApiOperation({ summary: 'Acknowledge an OPEN complaint' })
  acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcknowledgeComplaintDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.acknowledge(id, user, dto.notes);
  }

  @Post(':id/resolve')
  @RequirePermission(PERMISSIONS.COMPLAINT_RESOLVE)
  @ApiOperation({ summary: 'Resolve a complaint (resolutionNotes required)' })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveComplaintDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.resolve(id, user, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.COMPLAINT_MANAGE)
  @ApiOperation({ summary: 'Edit complaint descriptive fields (blocked once RESOLVED)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateComplaintDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user);
  }
}
