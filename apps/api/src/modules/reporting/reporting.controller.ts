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
  @ApiQuery({ name: 'includeHistorical', required: false, type: Boolean, description: 'Include HISTORICAL_IMPORT/placeholder records (default false)' })
  async getKpis(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('includeHistorical') includeHistorical?: string,
  ) {
    return this.reportingService.getKpis(siteId, startDate, endDate, includeHistorical === 'true');
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
  @ApiQuery({ name: 'includeHistorical', required: false, type: Boolean })
  async getTrends(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('metric') metric: TrendMetric,
    @Query('includeHistorical') includeHistorical?: string,
  ) {
    return this.reportingService.getTrendData(siteId, startDate, endDate, metric, includeHistorical === 'true');
  }

  @Get('technician-utilization')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get technician utilization for a site over a date range' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({ name: 'startDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'includeHistorical', required: false, type: Boolean })
  async getTechnicianUtilization(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('includeHistorical') includeHistorical?: string,
  ) {
    return this.reportingService.getTechnicianUtilization(siteId, startDate, endDate, includeHistorical === 'true');
  }

  @Get('service-breakdown')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get service order counts broken down by service type family' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({ name: 'startDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'includeHistorical', required: false, type: Boolean })
  async getServiceBreakdown(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('includeHistorical') includeHistorical?: string,
  ) {
    return this.reportingService.getServiceFamilyBreakdown(siteId, startDate, endDate, includeHistorical === 'true');
  }

  @Get('maintenance-retention')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get maintenance retention analytics (overdue, upcoming, opportunities)' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({ name: 'includeHistorical', required: false, type: Boolean })
  async getMaintenanceRetention(
    @Query('siteId') siteId: string,
    @Query('includeHistorical') includeHistorical?: string,
  ) {
    return this.reportingService.getMaintenanceRetention(siteId, includeHistorical === 'true');
  }

  @Get('queue-performance')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get queue performance summary for a site over a date range' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({ name: 'startDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'endDate', required: true, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'includeHistorical', required: false, type: Boolean })
  async getQueuePerformance(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('includeHistorical') includeHistorical?: string,
  ) {
    return this.reportingService.getQueuePerformanceSummary(siteId, startDate, endDate, includeHistorical === 'true');
  }

  @Get('historical-analytics')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Read-only historical-import analytics (managers; HISTORICAL_IMPORT only)' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  async getHistoricalAnalytics(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportingService.getHistoricalAnalytics({ from, to });
  }

  @Get('service-mix')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Read-only Service Mix / Job-Category analytics (CR-2026-019 P1c)' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'mode', required: false, enum: ['auto', 'suggested'], description: 'auto = AUTO_MATCHED only; suggested = include NEEDS_REVIEW in volume (low-confidence)' })
  async getServiceMix(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('category') category?: string,
    @Query('mode') mode?: 'auto' | 'suggested',
  ) {
    return this.reportingService.getServiceMix({ from, to, category, mode });
  }
}
