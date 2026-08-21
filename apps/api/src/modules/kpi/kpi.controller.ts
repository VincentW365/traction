import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { KpiService } from './kpi.service';
import { KpiReportingService } from './kpi-reporting.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { RecordDelayDto, DecideDelayDto } from './dto/kpi-delay.dto';

/**
 * CR-2026-088 — technician KPI.
 *
 * Live figures are readable by anyone who can act on a service order (technicians
 * see their own card). The dashboard and CSV are manager-only: an individual's
 * comparative rating is management information, and it is never exposed on the
 * customer display.
 */
@ApiTags('Technician KPI')
@Controller('kpi')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class KpiController {
  constructor(
    private readonly kpi: KpiService,
    private readonly reporting: KpiReportingService,
  ) {}

  @Get('orders/:serviceOrderId/live')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Live KPI position for a job in progress' })
  getLive(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.kpi.getLiveKpi(serviceOrderId);
  }

  @Get('orders/:serviceOrderId/package')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'The detected benchmark package for a job' })
  detectPackage(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.kpi.detectPackageForOrder(serviceOrderId);
  }

  @Get('orders/:serviceOrderId/delays')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Delays recorded against a job' })
  listDelays(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.kpi.listDelays(serviceOrderId);
  }

  @Post('orders/:serviceOrderId/delays')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({
    summary:
      'Record a delay. A technician may request KPI exclusion, but it stays pending until a supervisor decides.',
  })
  async recordDelay(
    @Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string,
    @Body() dto: RecordDelayDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.kpi.recordDelay({
      serviceOrderId,
      technicianId: dto.technicianId,
      reasonCode: dto.reasonCode,
      description: dto.description,
      startedAt: new Date(dto.startedAt),
      endedAt: dto.endedAt ? new Date(dto.endedAt) : null,
      requestedForExclusion: dto.requestedForExclusion,
      recordedByUserId: user.sub,
    });
  }

  @Post('delays/:delayId/end')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Close an open delay' })
  endDelay(
    @Param('delayId', ParseUUIDPipe) delayId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.kpi.endDelay(delayId, user.sub);
  }

  // Approving an exclusion changes someone's measured performance, so it sits
  // behind the manager permission, not the technician one.
  @Post('delays/:delayId/decision')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Approve or reject a KPI exclusion request (supervisor)' })
  decideDelay(
    @Param('delayId', ParseUUIDPipe) delayId: string,
    @Body() dto: DecideDelayDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.kpi.decideDelay({
      delayId,
      approve: dto.approve,
      actorUserId: user.sub,
      rejectionReason: dto.rejectionReason,
    });
  }

  // -------------------------------------------------------------------------
  // Manager dashboard
  // -------------------------------------------------------------------------

  @Get('dashboard')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Manager KPI dashboard' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'technicianId', required: false })
  @ApiQuery({ name: 'vehicleClass', required: false })
  @ApiQuery({ name: 'packageType', required: false })
  @ApiQuery({ name: 'adjustedRating', required: false })
  @ApiQuery({ name: 'absoluteRating', required: false })
  @ApiQuery({ name: 'hadRework', required: false })
  @ApiQuery({ name: 'benchmarkedOnly', required: false })
  dashboard(@Query() query: Record<string, string>) {
    return this.reporting.getDashboard(query);
  }

  @Get('dashboard/jobs')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'Job-level KPI rows behind the dashboard, for review and CSV export',
  })
  jobs(@Query() query: Record<string, string>) {
    return this.reporting.getJobRows(query);
  }
}
