import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { TechniciansService } from './technicians.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Technicians')
@Controller('technicians')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class TechniciansController {
  constructor(private readonly techniciansService: TechniciansService) {}

  @Get()
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'List active technicians for a site' })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  async findBySite(@Query('siteId') siteId: string) {
    return this.techniciansService.findBySite(siteId);
  }

  @Get('available')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({
    summary: 'Find technicians with required skills and compatible bays',
  })
  @ApiQuery({ name: 'siteId', required: true, type: String })
  @ApiQuery({
    name: 'skillCodes',
    required: false,
    type: String,
    description: 'Comma-separated skill codes',
  })
  @ApiQuery({
    name: 'bayTypes',
    required: false,
    type: String,
    description: 'Comma-separated bay types',
  })
  async findAvailable(
    @Query('siteId') siteId: string,
    @Query('skillCodes') skillCodes?: string,
    @Query('bayTypes') bayTypes?: string,
  ) {
    const parsedSkillCodes = skillCodes
      ? skillCodes.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const parsedBayTypes = bayTypes
      ? bayTypes.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    return this.techniciansService.findAvailableForService(
      siteId,
      parsedSkillCodes,
      parsedBayTypes,
    );
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  @ApiOperation({ summary: 'Get technician detail with skills' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.techniciansService.findById(id);
  }

  @Get(':id/active-assignment')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({
    summary: 'Get current active assignment for a technician (double-booking check)',
  })
  async getActiveAssignment(@Param('id', ParseUUIDPipe) id: string) {
    return this.techniciansService.getActiveAssignment(id);
  }
}
