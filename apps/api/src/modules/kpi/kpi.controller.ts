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
import { KpiService } from './kpi.service';
import { KpiReportingService } from './kpi-reporting.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { RecordDelayDto, DecideDelayDto } from './dto/kpi-delay.dto';
import { ApproveCustomStandardDto } from './dto/kpi-custom-standard.dto';
import { KpiMappingService } from './kpi-mapping.service';
import { WorkSegmentService } from './work-segment.service';
import {
  UpsertKpiMappingDto,
  DeactivateKpiMappingDto,
  CorrectWorkSegmentDto,
} from './dto/kpi-mapping.dto';

/**
 * CR-2026-088 — technician KPI.
 *
 * Live figures are readable by anyone who can act on a service order (technicians
 * see their own card). The dashboard and CSV are manager-only: an individual's
 * comparative rating is management information, and it is never exposed on the
 * customer display.
 */
@ApiTags('Technician KPI')
@Controller('kpi')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class KpiController {
  constructor(
    private readonly kpi: KpiService,
    private readonly reporting: KpiReportingService,
    private readonly mapping: KpiMappingService,
    private readonly segments: WorkSegmentService,
  ) {}

  @Get('orders/:serviceOrderId/live')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Live KPI position for a job in progress' })
  getLive(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.kpi.getLiveKpi(serviceOrderId);
  }

  @Get('orders/:serviceOrderId/package')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'The detected benchmark package for a job' })
  detectPackage(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.kpi.detectPackageForOrder(serviceOrderId);
  }

  @Get('orders/:serviceOrderId/delays')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Delays recorded against a job' })
  listDelays(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.kpi.listDelays(serviceOrderId);
  }

  @Post('orders/:serviceOrderId/delays')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({
    summary:
      'Record a delay. A technician may request KPI exclusion, but it stays pending until a supervisor decides.',
  })
  async recordDelay(
    @Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string,
    @Body() dto: RecordDelayDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.kpi.recordDelay({
      serviceOrderId,
      technicianId: dto.technicianId,
      reasonCode: dto.reasonCode,
      description: dto.description,
      startedAt: new Date(dto.startedAt),
      endedAt: dto.endedAt ? new Date(dto.endedAt) : null,
      requestedForExclusion: dto.requestedForExclusion,
      recordedByUserId: user.sub,
    });
  }

  @Post('delays/:delayId/end')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Close an open delay' })
  endDelay(
    @Param('delayId', ParseUUIDPipe) delayId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.kpi.endDelay(delayId, user.sub);
  }

  // Approving an exclusion changes someone's measured performance, so it sits
  // behind the manager permission, not the technician one.
  @Post('delays/:delayId/decision')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Approve or reject a KPI exclusion request (supervisor)' })
  decideDelay(
    @Param('delayId', ParseUUIDPipe) delayId: string,
    @Body() dto: DecideDelayDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.kpi.decideDelay({
      delayId,
      approve: dto.approve,
      actorUserId: user.sub,
      rejectionReason: dto.rejectionReason,
    });
  }

  @Post('orders/:serviceOrderId/custom-standard')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary:
      'Approve a custom standard for an unbenchmarked job. Must be set before the job finishes.',
  })
  approveCustomStandard(
    @Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string,
    @Body() dto: ApproveCustomStandardDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.kpi.approveCustomStandard({
      serviceOrderId,
      standardMinutes: dto.standardMinutes,
      reason: dto.reason,
      actorUserId: user.sub,
    });
  }

  // -------------------------------------------------------------------------
  // Manager dashboard
  // -------------------------------------------------------------------------

  @Get('dashboard')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Manager KPI dashboard' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'technicianId', required: false })
  @ApiQuery({ name: 'vehicleClass', required: false })
  @ApiQuery({ name: 'packageType', required: false })
  @ApiQuery({ name: 'adjustedRating', required: false })
  @ApiQuery({ name: 'absoluteRating', required: false })
  @ApiQuery({ name: 'hadRework', required: false })
  @ApiQuery({ name: 'benchmarkedOnly', required: false })
  dashboard(@Query() query: Record<string, string>) {
    return this.reporting.getDashboard(query);
  }

  @Get('dashboard/jobs')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'Job-level KPI rows behind the dashboard, for review and CSV export',
  })
  jobs(@Query() query: Record<string, string>) {
    return this.reporting.getJobRows(query);
  }

  /**
   * CR-2026-090 — shared and reassigned jobs.
   *
   * A separate report rather than a dashboard filter, because these jobs are
   * deliberately excluded from individual comparison and mixing them into the
   * ranking view is how they end up being compared anyway.
   */
  @Get('reports/shared-jobs')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary:
      'Jobs worked by more than one technician, with labour measures. Informational — not individual KPI.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'technicianId', required: false })
  sharedJobs(@Query() query: Record<string, string>) {
    return this.reporting.getSharedJobs(query);
  }

  /**
   * CR-2026-091 — jobs held because benchmark configuration is missing.
   *
   * These carry no rating and sit outside every technician denominator. The queue
   * exists so a temporary gap does not become a permanent one: nothing else surfaces
   * them, and an unrated job that nobody looks at is an unrated job forever.
   */
  @Get('reports/benchmark-review')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary: 'Jobs awaiting benchmark configuration, with the services blocking each',
  })
  benchmarkReviewQueue() {
    return this.kpi.listPendingBenchmarkReview();
  }

  @Post('orders/:serviceOrderId/resolve-benchmark-review')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({
    summary:
      'Rate a job that was held for benchmark review, now the mapping exists. Refuses any job that already carries a rating.',
  })
  resolveBenchmarkReview(
    @Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.kpi.resolveBenchmarkReview(serviceOrderId, user.sub);
  }

  /**
   * CR-2026-092 — observed times for additive services, so a manager can judge whether
   * a configured standard still matches reality. Never applied automatically.
   */
  @Get('reports/additive-evidence')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Observed vs configured times for additive services (decision support)' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  additiveEvidence(@Query() query: Record<string, string>) {
    return this.reporting.getAdditiveServiceEvidence(query);
  }

  // -------------------------------------------------------------------------
  // Work segments (CR-2026-090)
  // -------------------------------------------------------------------------

  @Get('orders/:serviceOrderId/segments')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Technician work segments recorded against a job' })
  listSegments(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.segments.listForOrder(serviceOrderId);
  }

  @Get('orders/:serviceOrderId/labour')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({
    summary:
      'Labour measures for a job: per-technician active minutes, team labour, coverage and concurrent assistance',
  })
  labour(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.segments.getLabourForOrder(serviceOrderId);
  }

  // Correcting a segment changes a labour figure, so it is manager-only and always
  // carries a reason.
  @Post('segments/:segmentId/correct')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Correct a work segment’s times (manager, audited, reason required)' })
  correctSegment(
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
    @Body() dto: CorrectWorkSegmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.segments.correctSegment(
      segmentId,
      {
        startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
        endedAt:
          dto.endedAt === undefined ? undefined : dto.endedAt ? new Date(dto.endedAt) : null,
        reason: dto.reason,
      },
      user.sub,
    );
  }

  // -------------------------------------------------------------------------
  // Package-component mapping administration (CR-2026-090)
  // -------------------------------------------------------------------------

  @Get('mappings')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({ summary: 'Every service with its current KPI component mapping' })
  @ApiQuery({ name: 'includeHistory', required: false })
  listMappings(@Query('includeHistory') includeHistory?: string) {
    return this.mapping.list(includeHistory === 'true');
  }

  @Get('mappings/:serviceTypeId/history')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({ summary: 'Mapping history for one service' })
  mappingHistory(@Param('serviceTypeId', ParseUUIDPipe) serviceTypeId: string) {
    return this.mapping.history(serviceTypeId);
  }

  @Post('mappings')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({
    summary: 'Set a service’s KPI component mapping. Supersedes rather than overwrites.',
  })
  upsertMapping(@Body() dto: UpsertKpiMappingDto, @CurrentUser() user: JwtPayload) {
    return this.mapping.upsert(
      {
        serviceTypeId: dto.serviceTypeId,
        componentRole: dto.componentRole,
        requiresAxleQualifier: dto.requiresAxleQualifier,
        notes: dto.notes,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : undefined,
        contributionMode: dto.contributionMode,
        durationSource: dto.durationSource,
        allowanceBasis: dto.allowanceBasis,
        requiredQualifier: dto.requiredQualifier,
        fixedSedanMinutes: dto.fixedSedanMinutes,
        fixedSuvMinutes: dto.fixedSuvMinutes,
        provisionalDuration: dto.provisionalDuration,
        isSupersededCode: dto.isSupersededCode,
      },
      user.sub,
    );
  }

  @Post('mappings/:mappingId/deactivate')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({
    summary: 'Stop a mapping applying to new jobs. Never deletes — history stays explicable.',
  })
  deactivateMapping(
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @Body() dto: DeactivateKpiMappingDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.mapping.deactivate(mappingId, user.sub, dto?.reason);
  }
}
