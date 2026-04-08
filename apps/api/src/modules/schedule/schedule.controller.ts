import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Schedule')
@Controller('schedule')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ScheduleController {
  constructor(private scheduleService: ScheduleService) {}

  @Get('day')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get consolidated day schedule: resources, events, queue rail, stats' })
  async getDaySchedule(
    @Query('siteId') siteId: string,
    @Query('date') date: string,
  ) {
    return this.scheduleService.getDaySchedule(siteId, date);
  }

  @Get('week')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get week capacity summary' })
  async getWeekSchedule(
    @Query('siteId') siteId: string,
    @Query('weekStart') weekStart: string,
  ) {
    return this.scheduleService.getWeekSchedule(siteId, weekStart);
  }
}
