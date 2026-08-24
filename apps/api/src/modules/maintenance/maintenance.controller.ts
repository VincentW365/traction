import {
  BadRequestException,
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { MaintenanceService } from './maintenance.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { DecodeVehicleDto } from './dto/decode-vehicle.dto';
import { FluidRecommendationQueryDto } from './dto/fluid-recommendation.dto';
import { AdvisoryRecommendationQueryDto } from './dto/advisory-recommendation.dto';
import { PostServiceRecommendationDto } from './dto/post-service-recommendation.dto';
import { OverrideRecommendationDto } from './dto/override-recommendation.dto';
import { PriorServiceDto } from './dto/prior-service.dto';
import { MaintenanceHistoryQueryDto } from './dto/maintenance-history.dto';
import { DueVehiclesQueryDto } from './dto/due-vehicles.dto';

@ApiTags('Maintenance - Vehicles')
@Controller('vehicles')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class MaintenanceVehicleController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post(':id/decode')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  @ApiOperation({
    summary: 'Decode vehicle Chassis Number/VIN and store spec snapshot',
  })
  async decodeVehicle(
    @Param('id', ParseUUIDPipe) vehicleId: string,
    @Body() dto: DecodeVehicleDto,
  ) {
    return this.maintenanceService.decodeVehicle(
      vehicleId,
      dto.forceRedecode ?? false,
    );
  }

  @Get(':id/fluid-recommendation')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  @ApiOperation({
    summary: 'Get fluid specification recommendation for a vehicle and service type',
  })
  async getFluidRecommendation(
    @Param('id', ParseUUIDPipe) vehicleId: string,
    @Query() query: FluidRecommendationQueryDto,
  ) {
    return this.maintenanceService.getFluidRecommendation(
      vehicleId,
      query.serviceTypeCode,
    );
  }

  @Get(':id/maintenance-recommendation')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  @ApiOperation({
    summary: 'Get advisory maintenance recommendation for a vehicle',
  })
  async getAdvisoryRecommendation(
    @Param('id', ParseUUIDPipe) vehicleId: string,
    @Query() query: AdvisoryRecommendationQueryDto,
  ) {
    return this.maintenanceService.getAdvisoryRecommendation(
      vehicleId,
      query.serviceTypeCode,
      query.drivingProfile ?? 'NORMAL',
    );
  }

  @Get(':id/maintenance-history')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  @ApiOperation({
    summary: 'Get maintenance recommendation history for a vehicle',
  })
  async getMaintenanceHistory(
    @Param('id', ParseUUIDPipe) vehicleId: string,
    @Query() query: MaintenanceHistoryQueryDto,
  ) {
    return this.maintenanceService.getRecommendationHistory(
      vehicleId,
      query.serviceTypeCode,
    );
  }

  @Post(':id/prior-service')
  @RequirePermission(PERMISSIONS.PRIOR_SERVICE_ENTRY)
  @ApiOperation({
    summary: 'Record a prior service performed elsewhere to establish a baseline',
  })
  async recordPriorService(
    @Param('id', ParseUUIDPipe) vehicleId: string,
    @Body() dto: PriorServiceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.maintenanceService.recordPriorService(
      vehicleId,
      dto.serviceTypeCode,
      dto.lastServiceOdometer ?? null,
      dto.lastServiceDate ? new Date(dto.lastServiceDate) : null,
      dto.source,
      dto.drivingProfile ?? 'NORMAL',
      user.sub,
    );
  }
}

@ApiTags('Maintenance - Service Orders')
@Controller('service-orders')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class MaintenanceServiceOrderController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post(':id/maintenance-recommendation')
  @RequirePermission(PERMISSIONS.MAINTENANCE_OVERRIDE)
  @ApiOperation({
    summary: 'Record post-service maintenance recommendation after service completion',
  })
  async recordPostService(
    @Param('id', ParseUUIDPipe) serviceOrderId: string,
    @Body() dto: PostServiceRecommendationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.maintenanceService.recordPostService(
      serviceOrderId,
      dto.serviceTypeCode,
      dto.completionOdometer,
      dto.drivingProfile ?? 'NORMAL',
      user.sub,
    );
  }
}

@ApiTags('Maintenance - Recommendations')
@Controller('maintenance-recommendations')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class MaintenanceRecommendationController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post(':id/override')
  @RequirePermission(PERMISSIONS.MAINTENANCE_OVERRIDE)
  @ApiOperation({
    summary: 'Override an existing maintenance recommendation (audited)',
  })
  async overrideRecommendation(
    @Param('id', ParseUUIDPipe) recommendationId: string,
    @Body() dto: OverrideRecommendationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.maintenanceService.overrideRecommendation(
      recommendationId,
      {
        nextDueOdometer: dto.nextDueOdometer,
        nextDueDate: dto.nextDueDate,
        intervalMiles: dto.intervalMiles,
        intervalMonths: dto.intervalMonths,
        drivingProfile: dto.drivingProfile,
      },
      dto.reason,
      user.sub,
    );
  }
}

@ApiTags('Maintenance - Reports')
@Controller('maintenance')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class MaintenanceDueController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Get('due-vehicles')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'Find vehicles approaching their maintenance due date/mileage',
  })
  async getDueVehicles(@Query() query: DueVehiclesQueryDto) {
    return this.maintenanceService.getDueVehicles(
      query.siteId,
      query.thresholdMiles,
      query.thresholdDays,
    );
  }

  // CR-2026-096 — follow-up outcome of a due-service contact (business status,
  // separate from notification delivery). Advisors work this list, so it sits on
  // MAINTENANCE_OVERRIDE rather than a manager-only permission.
  @Patch('recommendations/:id/contact-status')
  @RequirePermission(PERMISSIONS.MAINTENANCE_OVERRIDE)
  @ApiOperation({ summary: 'Set follow-up status for a due-service customer contact' })
  async setContactStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: { contactStatus: 'NOT_CONTACTED' | 'CONTACTED' | 'BOOKED' | 'DEFERRED' | 'DO_NOT_CONTACT' },
    @CurrentUser() user: JwtPayload,
  ) {
    const allowed = ['NOT_CONTACTED', 'CONTACTED', 'BOOKED', 'DEFERRED', 'DO_NOT_CONTACT'];
    if (!allowed.includes(body?.contactStatus)) {
      throw new BadRequestException(`contactStatus must be one of ${allowed.join(', ')}`);
    }
    return this.maintenanceService.setContactStatus(id, body.contactStatus, user.sub);
  }
}
