import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ClassificationService } from './classification.service';
import { ConfirmClassificationDto } from './dto/confirm-classification.dto';
import { BulkConfirmClassificationDto } from './dto/bulk-confirm-classification.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  JwtPayload,
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
  async queue(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    return this.classification.getQueue(n);
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
