import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Post('send-pickup-ready')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({
    summary: 'Send pickup-ready notification (front desk chooses channels)',
  })
  async sendPickupReady(
    @Body() body: { serviceVisitId: string; channels: string[] },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.notificationsService.sendPickupReady(
      body.serviceVisitId,
      body.channels,
      user.sub,
    );
  }

  @Post('midday-followup')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'DMAIC Rule 2: trigger midday follow-up for jobs completed before noon (idempotent)' })
  async middayFollowUp(@Body() body: { siteId: string }) {
    return this.notificationsService.sendMiddayCompletionFollowUp(body.siteId);
  }

  @Get('log')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get notification log for an entity' })
  async getLog(@Query('entityId') entityId: string) {
    return this.notificationsService.getLogForEntity(entityId);
  }
}
