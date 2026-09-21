import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReconciliationService, ReviewStatus } from './reconciliation.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CurrentUser, type JwtPayload } from '../../common/decorators/current-user.decorator';

/** CR-2026-099 — manager review of historical unknown-customer visits. */
@ApiTags('Data Review')
@Controller('reconciliation')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  @Get('summary')
  @RequirePermission(PERMISSIONS.CONFIG_VIEW)
  @ApiOperation({ summary: 'Unresolved / resolved / ambiguous counts' })
  summary() {
    return this.service.summary();
  }

  @Get('unresolved')
  @RequirePermission(PERMISSIONS.CONFIG_VIEW)
  @ApiOperation({ summary: 'Historical visits awaiting review, with extracted hints and high-confidence candidates' })
  list(
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('status') status?: ReviewStatus,
  ) {
    return this.service.listUnresolved(Number(take) || 25, Number(skip) || 0, status ?? 'UNRESOLVED');
  }

  @Post(':visitId/relink')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({ summary: 'Relink a historical visit to a real vehicle/customer (audited)' })
  relink(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Body() body: { vehicleId: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.relink(visitId, body.vehicleId, user.sub);
  }

  @Post(':visitId/ambiguous')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({ summary: 'Mark a historical visit reviewed-but-unlinkable (audited)' })
  ambiguous(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Body() body: { note?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.markAmbiguous(visitId, body?.note, user.sub);
  }
}
