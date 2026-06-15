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
import { TechniciansService } from './technicians.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { AddSkillDto } from './dto/add-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';

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

  // Declared BEFORE `:id` so the literal segment isn't captured as a technician id.
  @Get('recommended/:serviceOrderId')
  @RequirePermission(PERMISSIONS.SERVICE_ORDER_ASSIGN)
  @ApiOperation({ summary: 'Ranked recommended technicians for a service order (advisory; staff still confirm)' })
  async getRecommended(@Param('serviceOrderId', ParseUUIDPipe) serviceOrderId: string) {
    return this.techniciansService.getRecommendedTechnicians(serviceOrderId);
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

  // --- Skill CRUD ---

  @Post(':id/skills')
  @RequirePermission(PERMISSIONS.TECHNICIAN_MANAGE)
  @ApiOperation({ summary: 'Add a skill to a technician' })
  async addSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddSkillDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.techniciansService.addSkill(id, dto, user.sub);
  }

  @Patch(':id/skills/:skillId')
  @RequirePermission(PERMISSIONS.TECHNICIAN_MANAGE)
  @ApiOperation({ summary: 'Update a technician skill' })
  async updateSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('skillId', ParseUUIDPipe) skillId: string,
    @Body() dto: UpdateSkillDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.techniciansService.updateSkill(id, skillId, dto, user.sub);
  }

  @Delete(':id/skills/:skillId')
  @RequirePermission(PERMISSIONS.TECHNICIAN_MANAGE)
  @ApiOperation({ summary: 'Remove a skill from a technician' })
  async removeSkill(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('skillId', ParseUUIDPipe) skillId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.techniciansService.removeSkill(id, skillId, user.sub);
  }
}
