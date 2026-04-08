import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ExternalRefService } from './external-ref.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Integrations')
@Controller('integrations')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ExternalRefController {
  constructor(private externalRefService: ExternalRefService) {}

  @Post('link')
  @RequirePermission(PERMISSIONS.PARTS_MANAGE)
  async linkExternal(
    @Body() body: { system: 'AUTOMATE' | 'SAGE'; entityType: string; entityId: string; externalId: string; metadata?: Record<string, unknown> },
  ) {
    return this.externalRefService.linkExternal(
      body.system,
      body.entityType,
      body.entityId,
      body.externalId,
      body.metadata,
    );
  }

  @Get('refs')
  @RequirePermission(PERMISSIONS.QUEUE_VIEW)
  async getRefsForEntity(@Query('entityId') entityId: string) {
    return this.externalRefService.getRefsForEntity(entityId);
  }
}
