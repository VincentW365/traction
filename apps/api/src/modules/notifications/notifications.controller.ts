import { Controller, Get, Post, Put, Param, Body, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import {
  ComposeInput,
  CustomerNotificationsService,
  SendInput,
} from './customer-notifications.service';
import { NotificationReason } from '@prisma/client';
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
  constructor(
    private notificationsService: NotificationsService,
    private customerNotifications: CustomerNotificationsService,
  ) {}

  // -------------------------------------------------------------------------
  // CR-2026-096 — unified customer notifications
  // -------------------------------------------------------------------------

  @Get('capabilities')
  @RequirePermission(PERMISSIONS.NOTIFY_SEND)
  @ApiOperation({ summary: 'What this deployment can deliver (SMS/email configured, test mode)' })
  capabilities() {
    return this.customerNotifications.capabilities();
  }

  // CR-2026-106 — prove outbound email works: transport verification + a real test
  // send to the given address, recorded with the provider's response.
  @Post('verify')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({ summary: 'Verify the email transport and send a real test message (manager)' })
  verify(@Body() body: { to?: string }, @CurrentUser() user: JwtPayload) {
    const to = (body?.to ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new BadRequestException('Provide a valid email address to send the verification message to.');
    }
    return this.notificationsService.verifyEmail(to, user.sub);
  }

  @Post('compose')
  @RequirePermission(PERMISSIONS.NOTIFY_SEND)
  @ApiOperation({ summary: 'Build composer context + generated drafts for a customer notification' })
  compose(@Body() body: ComposeInput) {
    return this.customerNotifications.compose(body);
  }

  @Post('send')
  @RequirePermission(PERMISSIONS.NOTIFY_SEND)
  @ApiOperation({ summary: 'Send a reviewed/edited customer notification (SMS and/or email)' })
  send(@Body() body: SendInput, @CurrentUser() user: JwtPayload) {
    return this.customerNotifications.send(body, user.sub);
  }

  @Post('manual-contact')
  @RequirePermission(PERMISSIONS.NOTIFY_SEND)
  @ApiOperation({ summary: 'Record that the customer was contacted manually (call / in person)' })
  manualContact(
    @Body()
    body: {
      customerId: string;
      vehicleId?: string;
      serviceVisitId?: string;
      recommendationId?: string;
      reason: NotificationReason;
      method: 'PHONE_CALL' | 'IN_PERSON' | 'OTHER';
      note?: string;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customerNotifications.markManualContact(body, user.sub);
  }

  @Get('history')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Communication history for a customer, vehicle, or visit' })
  historyList(
    @Query('customerId') customerId?: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('serviceVisitId') serviceVisitId?: string,
  ) {
    return this.customerNotifications.history({ customerId, vehicleId, serviceVisitId });
  }

  @Get('record/:id')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Full record of one sent notification' })
  record(@Param('id') id: string) {
    return this.customerNotifications.getNotification(id);
  }

  @Post('retry/:id')
  @RequirePermission(PERMISSIONS.NOTIFY_SEND)
  @ApiOperation({ summary: 'Retry a failed notification (new auditable attempt)' })
  retry(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.customerNotifications.retry(id, user.sub);
  }

  @Get('templates')
  @RequirePermission(PERMISSIONS.CONFIG_VIEW)
  @ApiOperation({ summary: 'List notification templates (admin-editable wording)' })
  listTemplates() {
    return this.customerNotifications.listTemplates();
  }

  @Put('templates/:key')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({ summary: 'Update a notification template (no redeploy needed; versioned + audited)' })
  updateTemplate(
    @Param('key') key: string,
    @Body() body: { name?: string; subject?: string | null; body?: string; enabled?: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customerNotifications.updateTemplate(key, body, user.sub);
  }

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

  @Post('appointment-reminders')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'CR-2026-056: manually run the 24h appointment-reminder sweep (idempotent; normally hourly cron)' })
  async appointmentReminders() {
    return this.notificationsService.sweepAppointmentReminders();
  }

  @Get('log')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get notification log for an entity' })
  async getLog(@Query('entityId') entityId: string) {
    return this.notificationsService.getLogForEntity(entityId);
  }
}
