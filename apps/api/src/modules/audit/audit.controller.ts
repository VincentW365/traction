import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { StatusHistoryService } from './status-history.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Audit')
@Controller()
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(
    private auditService: AuditService,
    private statusHistoryService: StatusHistoryService,
  ) {}

  @Get('audit-logs')
  @RequirePermission(PERMISSIONS.AUDIT_VIEW)
  @ApiOperation({ summary: 'Search audit logs' })
  async searchAuditLogs(
    @Query('actorId') actorId?: string,
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.auditService.search({
      actorId,
      entityType,
      action,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get('status-history')
  @ApiOperation({ summary: 'Get status history for an entity' })
  async getStatusHistory(
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
  ) {
    return this.statusHistoryService.findByEntity(entityType, entityId);
  }
}
