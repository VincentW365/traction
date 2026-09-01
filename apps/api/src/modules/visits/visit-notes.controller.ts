import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { VisitNoteKind } from '@prisma/client';
import { VisitNotesService } from './visit-notes.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

export class CreateVisitNoteDto {
  @ApiProperty({ enum: VisitNoteKind, description: 'What kind of note this is (role-gated server-side)' })
  @IsEnum(VisitNoteKind)
  kind!: VisitNoteKind;

  @ApiProperty({ description: 'The note text' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text!: string;

  @ApiPropertyOptional({ description: 'Narrow the note to one job on the visit' })
  @IsOptional()
  @IsUUID()
  serviceOrderId?: string;

  @ApiPropertyOptional({ description: 'Ask for advisor/manager attention (SAFETY and DATA_REPORT always do)' })
  @IsOptional()
  @IsBoolean()
  requestAttention?: boolean;
}

export class ResolveVisitNoteDto {
  @ApiPropertyOptional({ description: 'What was done about it' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolutionNotes?: string;
}

/**
 * CR-2026-101 — typed operational visit notes.
 *
 * Reads ride QUEUE_VIEW (every operational role, technicians included).
 * Creation rides SERVICE_ORDER_STATUS with the KIND gated by role in the
 * service — a technician records findings/safety/data reports, never customer
 * concerns or manager instructions. Attention queue + resolve are
 * advisor/manager (SERVICE_ORDER_ASSIGN).
 */
@ApiTags('Visit Notes')
@Controller()
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class VisitNotesController {
  constructor(private readonly notes: VisitNotesService) {}

  // Declared before the :id routes elsewhere is irrelevant here (own paths).
  @Get('visit-notes/attention')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Open attention items: safety flags, incorrect-data reports, requests' })
  async attention(@Query('siteId') siteId?: string) {
    return this.notes.listAttention(siteId);
  }

  @Get('service-visits/:id/notes')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'All typed notes on a visit (author, role, timestamp on every row)' })
  async list(@Param('id', ParseUUIDPipe) id: string) {
    return this.notes.listForVisit(id);
  }

  @Post('service-visits/:id/notes')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_STATUS)
  @ApiOperation({ summary: 'Add a typed note (kind gated by role server-side)' })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVisitNoteDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.notes.addNote(id, dto, { sub: user.sub, role: user.role });
  }

  @Post('visit-notes/:id/resolve')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Mark an attention item handled (recorded, never deleted)' })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveVisitNoteDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.notes.resolve(id, dto.resolutionNotes, user.sub);
  }
}
