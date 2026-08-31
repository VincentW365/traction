import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { StaffService } from './staff.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { LinkTechnicianDto } from './dto/link-technician.dto';
import { SetSeniorityDto } from './dto/set-seniority.dto';

@ApiTags('Staff')
@Controller('staff')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  @RequirePermission(PERMISSIONS.STAFF_VIEW)
  @ApiOperation({ summary: 'List staff members' })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'roleCode', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'search', required: false })
  async findAll(
    @Query('siteId') siteId?: string,
    @Query('roleCode') roleCode?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.staffService.findAll({ siteId, roleCode, status, search });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.STAFF_VIEW)
  @ApiOperation({ summary: 'Get staff member detail' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.staffService.findById(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.STAFF_CREATE)
  @ApiOperation({ summary: 'Create new staff member' })
  async create(
    @Body() dto: CreateStaffDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.staffService.create(dto, user.sub, user.siteId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.STAFF_UPDATE)
  @ApiOperation({ summary: 'Update staff member' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.staffService.update(id, dto, user.sub);
  }

  @Post(':id/deactivate')
  @RequirePermission(PERMISSIONS.STAFF_DEACTIVATE)
  @ApiOperation({ summary: 'Deactivate staff member' })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.staffService.deactivate(id, user.sub);
  }

  @Post(':id/reactivate')
  @RequirePermission(PERMISSIONS.STAFF_UPDATE)
  @ApiOperation({ summary: 'Reactivate staff member' })
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.staffService.reactivate(id, user.sub);
  }

  // CR-2026-099 — manager-set temporary password (forgot-password recovery).
  @Post(':id/reset-password')
  @RequirePermission(PERMISSIONS.STAFF_UPDATE)
  @ApiOperation({ summary: 'Reset a staff password to a manager-set temporary one (ends their sessions)' })
  async resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { temporaryPassword: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.staffService.resetPassword(id, body.temporaryPassword, user.sub);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.STAFF_DELETE)
  @ApiOperation({
    summary:
      'Delete a deactivated staff member with no operational history. Anyone with recorded work or audited actions stays deactivated instead.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.staffService.remove(id, user.sub);
  }

  @Post(':id/link-technician')
  @RequirePermission(PERMISSIONS.TECHNICIAN_MANAGE)
  @ApiOperation({ summary: 'Link staff member to a technician profile' })
  async linkTechnician(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkTechnicianDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.staffService.linkTechnician(id, dto, user.sub);
  }

  @Get(':id/technician')
  @RequirePermission(PERMISSIONS.STAFF_VIEW)
  @ApiOperation({ summary: 'Get technician profile for staff member' })
  async getTechnicianProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.staffService.getTechnicianProfile(id);
  }

  // CR-2026-087 — mark a technician senior. Senior technicians are the ones who
  // may be assigned a quality check, replacing the v1 shortcut where "senior tech
  // sign-off" was really just the manager role.
  @Patch(':id/technician/seniority')
  @RequirePermission(PERMISSIONS.TECHNICIAN_MANAGE)
  @ApiOperation({ summary: 'Set whether a technician is senior (may be assigned quality checks)' })
  async setSeniority(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetSeniorityDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.staffService.setSeniority(id, dto.isSenior, user.sub);
  }
}
