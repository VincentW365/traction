import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CreateAvailabilityDto } from './dto/create-availability.dto';
import { BulkAvailabilityDto } from './dto/bulk-availability.dto';

@ApiTags('Availability')
@Controller('availability')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  @Get()
  @RequirePermission(PERMISSIONS.AVAILABILITY_MANAGE)
  @ApiOperation({ summary: 'List availability by date range' })
  @ApiQuery({ name: 'siteId', required: true })
  @ApiQuery({ name: 'startDate', required: true, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'endDate', required: true, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'technicianIds', required: false, description: 'Comma-separated UUIDs' })
  async findByRange(
    @Query('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('technicianIds') technicianIds?: string,
  ) {
    const ids = technicianIds
      ? technicianIds.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    return this.availabilityService.findByRange({ siteId, startDate, endDate, technicianIds: ids });
  }

  @Post()
  @RequirePermission(PERMISSIONS.AVAILABILITY_MANAGE)
  @ApiOperation({ summary: 'Create or upsert day availability' })
  async upsert(
    @Body() dto: CreateAvailabilityDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.availabilityService.upsert(dto, user.sub);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.AVAILABILITY_MANAGE)
  @ApiOperation({ summary: 'Update existing availability record' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAvailabilityDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.availabilityService.update(id, dto, user.sub);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.AVAILABILITY_MANAGE)
  @ApiOperation({ summary: 'Remove availability record' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.availabilityService.remove(id, user.sub);
  }

  @Post('bulk')
  @RequirePermission(PERMISSIONS.AVAILABILITY_MANAGE)
  @ApiOperation({ summary: 'Bulk set week availability for a technician' })
  async bulkSet(
    @Body() dto: BulkAvailabilityDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.availabilityService.bulkSet(dto, user.sub);
  }
}
