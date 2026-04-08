import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ServiceOrdersService } from './service-orders.service';
import { CreateServiceOrderDto } from './dto/create-service-order.dto';
import { AssignTechnicianDto } from './dto/assign-technician.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Service Orders')
@Controller('service-orders')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ServiceOrdersController {
  constructor(private serviceOrdersService: ServiceOrdersService) {}

  @Post()
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_CREATE)
  @ApiOperation({ summary: 'Create a new service order for a visit' })
  async create(
    @Body() dto: CreateServiceOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.create(dto, user.sub);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_CREATE)
  @ApiOperation({ summary: 'Get service order by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.serviceOrdersService.findById(id);
  }

  @Get('by-visit/:serviceVisitId')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_CREATE)
  @ApiOperation({ summary: 'List service orders for a visit' })
  async findByVisit(
    @Param('serviceVisitId', ParseUUIDPipe) serviceVisitId: string,
  ) {
    return this.serviceOrdersService.findByVisit(serviceVisitId);
  }

  @Post(':id/approve')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_UPDATE)
  @ApiOperation({ summary: 'Approve a draft service order' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.approve(id, user.sub);
  }

  @Post(':id/assign')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Assign a technician and bay to a service order' })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignTechnicianDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.assign(id, dto, user.sub);
  }

  @Post(':id/status')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Change service order status' })
  async changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.changeStatus(id, dto, user.sub);
  }
}
