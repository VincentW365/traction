import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { MaintenanceReminderService } from './maintenance-reminder.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Maintenance - Reminders')
@Controller('maintenance-reminders')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class MaintenanceReminderController {
  constructor(
    private readonly reminderService: MaintenanceReminderService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  @ApiOperation({ summary: 'List maintenance reminders' })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['SCHEDULED', 'SENT', 'ACKNOWLEDGED', 'CANCELLED', 'SUPERSEDED'] })
  async findReminders(
    @Query('vehicleId') vehicleId?: string,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
  ) {
    return this.reminderService.findReminders({ vehicleId, customerId, status });
  }

  @Post('process')
  @RequirePermission(PERMISSIONS.MAINTENANCE_OVERRIDE)
  @ApiOperation({ summary: 'Process all scheduled reminders that are due' })
  async processScheduledReminders() {
    return this.reminderService.processScheduledReminders();
  }
}
