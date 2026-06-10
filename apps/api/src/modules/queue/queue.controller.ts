import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { QueueService } from './queue.service';
import { QueueOverrideDto, ClearOverrideDto } from './dto/queue-override.dto';
import { AbandonVisitDto } from './dto/abandon-visit.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

@ApiTags('Queue')
@Controller('queue')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class QueueBoardController {
  constructor(private queueService: QueueService) {}

  @Get('board')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get live FIFO queue board for a site' })
  async getBoard(@Query('siteId') siteId: string) {
    return this.queueService.getBoard(siteId);
  }

  @Post('recompute')
  @RequirePermission(PERMISSIONS.QUEUE_RECOMPUTE)
  @ApiOperation({ summary: 'Force FIFO position recalculation' })
  async recompute(@Body('siteId') siteId: string) {
    return this.queueService.triggerRecompute(siteId);
  }

  @Post('call-next')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Call next eligible ticket in FIFO order' })
  async callNext(
    @Body('siteId') siteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.queueService.callNext(siteId, user.sub);
  }

  @Get('ready-for-pickup')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get visits ready for pickup with customer contact info' })
  async getReadyForPickup(@Query('siteId') siteId: string) {
    return this.queueService.getReadyForPickup(siteId);
  }
}

@ApiTags('Queue Tickets')
@Controller('queue-tickets')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class QueueTicketsController {
  constructor(private queueService: QueueService) {}

  @Get(':id')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get ticket detail with event history' })
  async getTicketDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.queueService.getTicketDetail(id);
  }

  @Post(':id/override')
  @RequirePermission(PERMISSIONS.QUEUE_OVERRIDE)
  @ApiOperation({ summary: 'Pin ticket to specific FIFO position (manager override)' })
  async applyOverride(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueOverrideDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.queueService.applyOverride(id, dto, user.sub);
  }

  @Post(':id/clear-override')
  @RequirePermission(PERMISSIONS.QUEUE_OVERRIDE)
  @ApiOperation({ summary: 'Clear active override on queue ticket' })
  async clearOverride(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClearOverrideDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.queueService.clearOverride(id, user.sub, dto.reason);
  }

  @Post(':id/complete')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Mark queue ticket work as complete (technician action)' })
  async completeTicket(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.queueService.completeTicket(id, user.sub);
  }

  @Post(':id/abandon')
  @RequirePermission(PERMISSIONS.QUEUE_ABANDON)
  @ApiOperation({ summary: 'Mark visit as no-show / abandoned (drops out of the active queue)' })
  async abandonVisit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AbandonVisitDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.queueService.abandonVisit(id, dto, user.sub);
  }
}
