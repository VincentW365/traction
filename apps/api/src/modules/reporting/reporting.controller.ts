import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ReportingService, TrendMetric } from './reporting.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Reports')
@Controller('reports')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ReportingController {
  constructor(private reportingService: ReportingService) {}

  @Get('kpis')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get KPI dashboard data for a site and date range' })
  async getKpis(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportingService.getKpis(siteId, startDate, endDate);
  }

  // ---------------------------------------------------------------------------
  // Phase 5 — Advanced Analytics Endpoints
  // ---------------------------------------------------------------------------

  @Get('trends')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get daily trend data for a metric over a date range' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({ name: 'startDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'metric', required: true, enum: ['check_ins', 'wait_time', 'no_shows', 'overrides'] })
  async getTrends(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('metric') metric: TrendMetric,
  ) {
    return this.reportingService.getTrendData(siteId, startDate, endDate, metric);
  }

  @Get('technician-utilization')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get technician utilization for a site over a date range' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({ name: 'startDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  async getTechnicianUtilization(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportingService.getTechnicianUtilization(siteId, startDate, endDate);
  }

  @Get('service-breakdown')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get service order counts broken down by service type family' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({ name: 'startDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  async getServiceBreakdown(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportingService.getServiceFamilyBreakdown(siteId, startDate, endDate);
  }

  @Get('maintenance-retention')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get maintenance retention analytics (overdue, upcoming, opportunities)' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  async getMaintenanceRetention(
    @Query('siteId') siteId: string,
  ) {
    return this.reportingService.getMaintenanceRetention(siteId);
  }

  @Get('queue-performance')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get queue performance summary for a site over a date range' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({ name: 'startDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  async getQueuePerformance(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportingService.getQueuePerformanceSummary(siteId, startDate, endDate);
  }
}
