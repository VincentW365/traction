import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ScheduleHoldsService } from './schedule-holds.service';
import { CreateScheduleHoldDto } from './dto/create-schedule-hold.dto';
import { ConvertScheduleHoldDto } from './dto/convert-schedule-hold.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { SiteGuard } from '../../common/guards/site.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

/**
 * CR-2026-026 — Schedule Quick-Book Holds. Advisory only; isolated from the
 * scheduling engine. v1 reuses APPOINTMENT_CREATE for all actions.
 */
@ApiTags('Schedule Holds')
@Controller('schedule-holds')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ScheduleHoldsController {
  constructor(private readonly service: ScheduleHoldsService) {}

  @Post()
  @UseGuards(SiteGuard)
  @RequirePermission(PERMISSIONS.APPOINTMENT_CREATE)
  @ApiOperation({ summary: 'Create an advisory schedule hold (no customer/vehicle/service)' })
  create(@Body() dto: CreateScheduleHoldDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user.sub);
  }

  @Get()
  @RequirePermission(PERMISSIONS.APPOINTMENT_CREATE)
  @ApiOperation({ summary: 'List ACTIVE holds for a site on a date' })
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'date', required: true, description: 'YYYY-MM-DD' })
  list(@Query('siteId') siteId: string, @Query('date') date: string) {
    return this.service.listForDay(siteId, date);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.APPOINTMENT_CREATE)
  @ApiOperation({ summary: 'Release a hold' })
  release(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.service.release(id, user.sub);
  }

  @Post(':id/convert')
  @RequirePermission(PERMISSIONS.APPOINTMENT_CREATE)
  @ApiOperation({ summary: 'Mark a hold CONVERTED and link the appointment it became' })
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertScheduleHoldDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.convert(id, dto.appointmentId, user.sub);
  }
}
