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
import { SetItemAxleDto, SetItemQualifiersDto } from './dto/set-item-axle.dto';
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
import {
  RejectPauseDto,
  CorrectPauseStartDto,
  StartAssignmentDto,
} from './dto/pause-approval.dto';
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
  @ApiOperation({
    summary:
      "The logged-in technician's own open assignments (default: ASSIGNED, IN_PROGRESS and PAUSED)",
  })
  async myAssignments(
    @Query('status') status: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    // CR-2026-084 — no longer defaults to ASSIGNED only, which made a job disappear
    // from the technician's screen the instant they started it.
    return this.serviceOrdersService.getMyAssignments(user.sub, status);
  }

  // CR-2026-101 — the technician's own workday clock (merged labour today).
  @Get('mine/workday')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: "The logged-in technician's real labour time today" })
  async myWorkday(@CurrentUser() user: JwtPayload) {
    return this.serviceOrdersService.getMyWorkdaySummary(user.sub);
  }

  // CR-2026-100 — pause requests awaiting advisor/manager acknowledgement.
  // Declared before ':id' so the literal path is not captured by the UUID param.
  @Get('pause-approvals/pending')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Technician pause requests awaiting acknowledgement' })
  async pendingPauseApprovals(@Query('siteId') siteId?: string) {
    return this.serviceOrdersService.listPendingPauseApprovals(siteId);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_VIEW)
  @ApiOperation({ summary: 'Get service order by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.serviceOrdersService.findById(id);
  }

  @Get(':id/pauses')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_VIEW)
  @ApiOperation({ summary: 'Pause/hold history for an order — the shared story every role reads' })
  async listPauses(@Param('id', ParseUUIDPipe) id: string) {
    return this.serviceOrdersService.listPauses(id);
  }

  // CR-2026-101 — the technician's read-only job context: customer slice,
  // vehicle record, visit, services + expected time, holds, inspections with
  // authorization states, job-sheet reference. Read access, no write path.
  @Get(':id/context')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_VIEW)
  @ApiOperation({ summary: 'Read-only job context: customer, vehicle, visit, work, holds, inspections' })
  async jobContext(@Param('id', ParseUUIDPipe) id: string) {
    return this.serviceOrdersService.getJobContext(id);
  }

  @Get(':id/vehicle-history')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_VIEW)
  @ApiOperation({ summary: "Previous visits/inspections for this job's vehicle (recent first)" })
  async vehicleHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.serviceOrdersService.getVehicleHistory(id);
  }

  @Post(':id/pauses/:pauseId/approve')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: "Acknowledge a technician's pause (never moves the clock)" })
  async approvePause(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pauseId', ParseUUIDPipe) pauseId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.approvePause(id, pauseId, user.sub);
  }

  @Post(':id/pauses/:pauseId/reject')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Reject a pause request (reason required; request is kept, work resumes)' })
  async rejectPause(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pauseId', ParseUUIDPipe) pauseId: string,
    @Body() dto: RejectPauseDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.rejectPause(id, pauseId, dto.reason, user.sub);
  }

  @Post(':id/pauses/:pauseId/correct-start')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({
    summary: 'Correct when a pause took effect (earlier only; reasoned, original kept, audited)',
  })
  async correctPauseStart(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pauseId', ParseUUIDPipe) pauseId: string,
    @Body() dto: CorrectPauseStartDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.correctPauseStart(id, pauseId, dto, user.sub);
  }

  @Get('by-visit/:serviceVisitId')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_VIEW)
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
    return this.serviceOrdersService.assignAllForVisit(serviceVisitId, dto.technicianId, user.sub, dto.acknowledgeWorkload);
  }

  @Get(':id/work-timing')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Work timing for a live job (start, completion, paused ms)' })
  async workTiming(@Param('id', ParseUUIDPipe) id: string) {
    return this.serviceOrdersService.getWorkTiming(id);
  }

  @Post(':id/ready-for-qc')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Assigned technician finishes work and sends the order to QC' })
  async readyForQc(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.readyForQc(id, user.sub);
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
    return this.serviceOrdersService.assignAdditional(id, dto.technicianId, dto.bayId, dto.resourceId, user.sub, dto.acknowledgeWorkload);
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

  /**
   * CR-2026-090 — record which axle a service line covers.
   *
   * Its own endpoint rather than part of the order edit, because the edit is limited
   * to DRAFT/APPROVED and the axle is often only settled once the vehicle is on the
   * ramp. Without this, a job whose only defect is a missing dropdown value would
   * stay unbenchmarked for good.
   */
  @Patch(':id/items/:itemId/axle')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Record which axle a service line covers (front/rear brake work)' })
  async setItemAxle(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: SetItemAxleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.setItemAxle(id, itemId, dto.axlePosition, user.sub);
  }

  /**
   * CR-2026-092 — record the structured qualifiers a conditional service needs.
   * Supersedes the axle-only endpoint, which stays for existing callers.
   */
  @Patch(':id/items/:itemId/qualifiers')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({
    summary: 'Record brake axle / work type, or tyre operation, on a service line',
  })
  async setItemQualifiers(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: SetItemQualifiersDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.setItemQualifiers(id, itemId, dto, user.sub);
  }

  /**
   * Whether the job can be benchmarked yet, and what is missing if not. Read by the
   * work-order screen so the answer arrives while somebody can still act on it.
   */
  @Get(':id/benchmark-readiness')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'KPI benchmark readiness and the calculated standard' })
  async benchmarkReadiness(@Param('id', ParseUUIDPipe) id: string) {
    return this.serviceOrdersService.getBenchmarkReadiness(id);
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
  @ApiOperation({
    summary:
      'Record assignment start time (409 with the active job when the technician is still on the clock elsewhere; pass holdReasonCode to switch)',
  })
  async startAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: StartAssignmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.serviceOrdersService.startAssignment(id, assignmentId, user.sub, dto);
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
