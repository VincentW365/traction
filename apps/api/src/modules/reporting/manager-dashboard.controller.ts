import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ManagerDashboardService } from './manager-dashboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Manager Dashboard')
@Controller('manager')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ManagerDashboardController {
  constructor(private readonly dashboardService: ManagerDashboardService) {}

  @Get('dashboard')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Manager control center KPIs' })
  @ApiQuery({ name: 'siteId', required: true })
  async getDashboard(@Query('siteId') siteId: string) {
    return this.dashboardService.getDashboard(siteId);
  }

  @Get('alerts')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Active operational alerts' })
  @ApiQuery({ name: 'siteId', required: true })
  async getAlerts(@Query('siteId') siteId: string) {
    return this.dashboardService.getAlerts(siteId);
  }
}
