import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { VisitsService } from './visits.service';
import { SearchService } from './search.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

/**
 * CR-2026-097 — the Visit Record: one authoritative aggregate per visit, plus
 * a merged activity timeline, a consolidated files view, and global search.
 */
@ApiTags('Visits')
@Controller()
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class VisitsController {
  constructor(
    private readonly visits: VisitsService,
    private readonly searchService: SearchService,
  ) {}

  @Get('visits/by-number/:visitNumber')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Resolve a human visit/ticket number to the visit id' })
  resolveByNumber(@Param('visitNumber') visitNumber: string) {
    return this.visits.resolveByNumber(visitNumber);
  }

  @Get('visits/:id')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Full Visit Record aggregate (customer, vehicle, services, inspections, job sheet)' })
  getRecord(@Param('id', ParseUUIDPipe) id: string) {
    return this.visits.getRecord(id);
  }

  @Get('visits/:id/timeline')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Chronological visit activity merged from existing audit/event infrastructure' })
  getTimeline(@Param('id', ParseUUIDPipe) id: string) {
    return this.visits.getTimeline(id);
  }

  @Get('visits/:id/files')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Consolidated visit photos/files grouped by originating record' })
  getFiles(@Param('id', ParseUUIDPipe) id: string) {
    return this.visits.getFiles(id);
  }

  @Get('search')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Global record search: customer, phone, plate, VIN, visit/ticket/inspection/job-sheet number' })
  search(@Query('q') q: string) {
    return this.searchService.search(q);
  }
}
