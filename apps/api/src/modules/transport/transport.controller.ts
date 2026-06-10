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
import { TransportService } from './transport.service';
import { CreateTransportRequestDto } from './dto/create-transport-request.dto';
import { AssignDriverDto } from './dto/assign-driver.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

// ---------------------------------------------------------------------------
// Transport Requests Controller
// ---------------------------------------------------------------------------

@ApiTags('Transport Requests')
@Controller('transport-requests')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class TransportRequestsController {
  constructor(private transportService: TransportService) {}

  @Post()
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'Create a transport request for a service visit' })
  async create(
    @Body() dto: CreateTransportRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transportService.create(dto, user.sub);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'Get a transport request by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.transportService.findById(id);
  }

  @Get('by-visit/:serviceVisitId')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'List transport requests for a service visit' })
  async findByVisit(
    @Param('serviceVisitId', ParseUUIDPipe) serviceVisitId: string,
  ) {
    return this.transportService.findByVisit(serviceVisitId);
  }

  @Post(':id/confirm')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'Customer confirms transport window' })
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transportService.confirmCustomer(id, user.sub);
  }

  @Post(':id/schedule')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'Schedule a transport request' })
  async schedule(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transportService.schedule(id, user.sub);
  }

  @Post(':id/assign-driver')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'Assign a driver to a transport request' })
  async assignDriver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDriverDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transportService.assignDriver(id, dto, user.sub);
  }

  @Post(':id/start')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'Mark transport as in progress' })
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transportService.start(id, user.sub);
  }

  @Post(':id/complete')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'Mark transport as completed' })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transportService.complete(id, user.sub);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'Cancel a transport request' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('reason') reason: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transportService.cancel(id, user.sub, reason);
  }
}

// ---------------------------------------------------------------------------
// Transport Dispatch Controller
// ---------------------------------------------------------------------------

@ApiTags('Transport Dispatch')
@Controller('transport')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class TransportDispatchController {
  constructor(private transportService: TransportService) {}

  @Get('dispatch')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({
    summary: 'Get dispatch board for a site — active transports grouped by status',
  })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  async getDispatchBoard(@Query('siteId', ParseUUIDPipe) siteId: string) {
    return this.transportService.getDispatchBoard(siteId);
  }

  @Get('drivers')
  @RequirePermission(PERMISSIONS.TRANSPORT_MANAGE)
  @ApiOperation({ summary: 'List candidate drivers (active staff) for assignment' })
  async getDrivers() {
    return this.transportService.getDrivers();
  }
}
