import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ClassificationConfidence } from '@prisma/client';
import { ClassificationService } from './classification.service';
import { ConfirmClassificationDto } from './dto/confirm-classification.dto';
import { BulkConfirmClassificationDto } from './dto/bulk-confirm-classification.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type JwtPayload,
} from '../../common/decorators/current-user.decorator';

/**
 * CR-2026-008 — vehicle classification review queue + staff confirmation.
 * RBAC: reuses VEHICLE_UPDATE for v1 (no new permission). Writes the operational
 * serviceClass only on explicit confirm/bulk-confirm.
 */
@ApiTags('Vehicles - Classification')
@Controller('vehicles/classification')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ClassificationController {
  constructor(private readonly classification: ClassificationService) {}

  @Get('queue')
  @RequirePermission(PERMISSIONS.VEHICLE_UPDATE)
  @ApiOperation({
    summary: 'List live vehicles awaiting serviceClass classification (with advisory suggestions)',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'confidence', required: false, enum: ClassificationConfidence })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'make / model / plate (partial)' })
  async queue(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('confidence') confidence?: string,
    @Query('search') search?: string,
  ) {
    let conf: ClassificationConfidence | undefined;
    if (confidence !== undefined && confidence !== '' && confidence !== 'ALL') {
      if (!(confidence in ClassificationConfidence)) {
        throw new BadRequestException(`Invalid confidence: ${confidence}`);
      }
      conf = confidence as ClassificationConfidence;
    }
    return this.classification.getQueue({
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
      offset: offset ? parseInt(offset, 10) || undefined : undefined,
      confidence: conf,
      search,
    });
  }

  @Get('stats')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Read-only classification progress snapshot (counts only; managers)' })
  async stats() {
    return this.classification.getStats();
  }

  @Get('productivity')
  @RequirePermission(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Read-only classification productivity (velocity, reviewers, daily target; managers)' })
  @ApiQuery({ name: 'days', required: false, type: Number, description: 'window size, 1–90 (default 14)' })
  async productivity(@Query('days') days?: string) {
    return this.classification.getProductivity({
      days: days ? parseInt(days, 10) || undefined : undefined,
    });
  }

  @Post(':vehicleId/confirm')
  @RequirePermission(PERMISSIONS.VEHICLE_UPDATE)
  @ApiOperation({ summary: 'Staff confirm/adjust a vehicle serviceClass (writes operational field + audit)' })
  async confirm(
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Body() dto: ConfirmClassificationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.classification.confirm(vehicleId, user.sub, dto);
  }

  @Post('bulk-confirm')
  @RequirePermission(PERMISSIONS.VEHICLE_UPDATE)
  @ApiOperation({ summary: 'Explicit staff-reviewed bulk confirm (each item carries the chosen class)' })
  async bulkConfirm(
    @Body() dto: BulkConfirmClassificationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.classification.bulkConfirm(user.sub, dto.items);
  }
}
