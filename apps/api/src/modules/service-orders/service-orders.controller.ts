import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ServiceOrdersService } from './service-orders.service';
import { CreateServiceOrderDto } from './dto/create-service-order.dto';
import { UpdateServiceOrderDto } from './dto/update-service-order.dto';
import { AssignTechnicianDto } from './dto/assign-technician.dto';
import { AssignAllDto } from './dto/assign-all.dto';
import { AssignAdditionalDto } from './dto/assign-additional.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
import {
  PauseServiceOrderDto,
  ResumeServiceOrderDto,
  ReworkServiceOrderDto,
} from './dto/pause-rework.dto';
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

  @Get('mine/assignments')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: "The logged-in technician's own assignments (default status ASSIGNED)" })
  async myAssignments(
    @Query('status') status: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.getMyAssignments(user.sub, status || 'ASSIGNED');
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

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_UPDATE)
  @ApiOperation({ summary: 'Edit a service order (items/notes) before work is assigned' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.updateOrder(id, dto, user.sub);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_UPDATE)
  @ApiOperation({ summary: 'Delete a service order before work is assigned' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.deleteOrder(id, user.sub);
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

  @Post('by-visit/:serviceVisitId/assign-all')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: "Assign one technician to ALL of a visit's approved orders (auto-bay each)" })
  async assignAll(
    @Param('serviceVisitId', ParseUUIDPipe) serviceVisitId: string,
    @Body() dto: AssignAllDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.assignAllForVisit(serviceVisitId, dto.technicianId, user.sub);
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

  // --- Pause / Resume / Rework (CR-2026-001) ---

  @Post(':id/pause')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Pause an in-progress service order (records reason + interval)' })
  async pause(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PauseServiceOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.pause(id, dto, user.sub);
  }

  @Post(':id/resume')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Resume a paused service order (closes the pause interval)' })
  async resume(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResumeServiceOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.resume(id, dto, user.sub);
  }

  @Post(':id/rework')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Send a service order in QC back for rework (preserves history)' })
  async rework(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReworkServiceOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.openRework(id, dto, user.sub);
  }

  // --- Multi-Tech Assignment ---

  @Post(':id/assign-additional')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Add an additional (helper) technician to a service order' })
  async assignAdditional(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignAdditionalDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.assignAdditional(id, dto.technicianId, dto.bayId, dto.resourceId, user.sub);
  }

  @Delete(':id/assignments/:assignmentId')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Remove a technician assignment' })
  async removeAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.removeAssignment(id, assignmentId, user.sub);
  }

  @Patch(':id/assignments/:assignmentId')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Update a technician assignment (swap tech, change primary)' })
  async updateAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: UpdateAssignmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.updateAssignment(id, assignmentId, dto, user.sub);
  }

  @Post(':id/assignments/:assignmentId/start')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Record assignment start time' })
  async startAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.startAssignment(id, assignmentId, user.sub);
  }

  @Post(':id/assignments/:assignmentId/end')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Record assignment end time' })
  async endAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.endAssignment(id, assignmentId, user.sub);
  }
}
