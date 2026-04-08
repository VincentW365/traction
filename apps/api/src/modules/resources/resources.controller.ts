import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ResourcesService } from './resources.service';
import { AssignResourceDto } from './dto/assign-resource.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('Resources')
@Controller('resources')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ResourcesController {
  constructor(private resourcesService: ResourcesService) {}

  @Get('board')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  async getDispatchBoard(@Query('siteId') siteId: string) {
    return this.resourcesService.getDispatchBoard(siteId);
  }

  @Post(':id/assign')
  @RequirePermission(PERMISSIONS.QUEUE_OVERRIDE)
  async assignToResource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignResourceDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.resourcesService.assignToResource(
      id,
      dto.queueTicketId,
      dto.technicianId ?? null,
      user.sub,
    );
  }

  @Post(':id/release')
  @RequirePermission(PERMISSIONS.QUEUE_OVERRIDE)
  async releaseResource(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.resourcesService.releaseResource(id, user.sub);
  }

  @Get('reservations')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  async getReservations(
    @Query('siteId') siteId: string,
    @Query('date') date: string,
  ) {
    return this.resourcesService.getReservations(siteId, date);
  }
}
