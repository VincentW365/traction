import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { InspectionsService } from './inspections.service';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { AddRecommendationDto } from './dto/add-recommendation.dto';
import { InspectionQueryDto } from './dto/inspection-query.dto';
import { SignoffInspectionDto } from './dto/signoff-inspection.dto';
import { DecideRecommendationDto } from './dto/decide-recommendation.dto';
import { CustomerSignoffDto } from './dto/customer-signoff.dto';
import { ToWorkOrderDto } from './dto/to-work-order.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

/**
 * CR-2026-034 (C-2) — Visual Inspection Form API core. Class guards JwtAuthGuard +
 * RbacGuard; site is derived from the visit and enforced in the service (create) and
 * on by-id ops (cross-site → NotFound; ADMIN bypass). Sign-off / customer decisions
 * / approved→work-order are C-3/C-5.
 */
@ApiTags('Inspections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacGuard)
@Controller('inspections')
export class InspectionsController {
  constructor(private readonly service: InspectionsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.INSPECTION_CREATE)
  @ApiOperation({ summary: 'Start a DRAFT inspection for a visit (snapshots the active template)' })
  @ApiCreatedResponse({ description: 'Inspection created (DRAFT)' })
  create(@Body() dto: CreateInspectionDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user);
  }

  @Get()
  @RequirePermission(PERMISSIONS.INSPECTION_VIEW)
  @ApiOperation({ summary: 'List inspections (site-scoped; filter by visit/status)' })
  @ApiOkResponse({ description: 'Paginated inspections' })
  list(@Query() query: InspectionQueryDto, @CurrentUser() user: JwtPayload) {
    return this.service.list(query, user);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.INSPECTION_VIEW)
  @ApiOperation({ summary: 'Inspection detail (items, wheels, recommendations, signatures, timeline)' })
  findById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findById(id, user);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Edit a DRAFT inspection (line results, wheel measurements, battery, flags, comments)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInspectionDto, @CurrentUser() user: JwtPayload) {
    return this.service.update(id, dto, user);
  }

  @Post(':id/recommendations')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Add a finding/recommendation to a DRAFT inspection' })
  addRecommendation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddRecommendationDto, @CurrentUser() user: JwtPayload) {
    return this.service.addRecommendation(id, dto, user);
  }

  @Post(':id/complete')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Mark a DRAFT inspection COMPLETED' })
  complete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.service.complete(id, user);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.INSPECTION_EDIT)
  @ApiOperation({ summary: 'Cancel a DRAFT or COMPLETED inspection' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.service.cancel(id, user);
  }

  // ─── C-3: sign-off + customer decisions ──────────────────────────────────────

  @Post(':id/signoff')
  @RequirePermission(PERMISSIONS.INSPECTION_SIGNOFF)
  @ApiOperation({ summary: 'Senior-tech sign-off (COMPLETED → SIGNED_OFF; locks results)' })
  signoff(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SignoffInspectionDto, @CurrentUser() user: JwtPayload) {
    return this.service.signoff(id, user, dto);
  }

  @Patch(':id/recommendations/:rid/decision')
  @RequirePermission(PERMISSIONS.INSPECTION_DECISION)
  @ApiOperation({ summary: 'Record the customer decision on a recommendation (APPROVED/DECLINED/DEFERRED)' })
  decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rid', ParseUUIDPipe) rid: string,
    @Body() dto: DecideRecommendationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.decideRecommendation(id, rid, user, dto);
  }

  @Post(':id/customer-signoff')
  @RequirePermission(PERMISSIONS.INSPECTION_DECISION)
  @ApiOperation({ summary: 'Capture customer sign-off (drawn or typed) → CLOSED' })
  customerSignoff(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerSignoffDto, @CurrentUser() user: JwtPayload) {
    return this.service.customerSignoff(id, user, dto);
  }

  @Post(':id/recommendations/:rid/to-work-order')
  @RequirePermission(PERMISSIONS.INSPECTION_DECISION)
  @ApiOperation({ summary: 'Turn an APPROVED recommendation into a service-order item (C-5)' })
  toWorkOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rid', ParseUUIDPipe) rid: string,
    @Body() dto: ToWorkOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.recommendationToWorkOrder(id, rid, user, dto);
  }
}
