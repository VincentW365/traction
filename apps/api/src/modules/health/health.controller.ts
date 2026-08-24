import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { HealthService } from './health.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

/**
 * CR-2026-094 — deployment verification.
 *
 * /health is deliberately UNGUARDED: a deploy pipeline, an uptime monitor and a
 * person checking "is the site the commit I pushed?" all need it before they have a
 * token. It therefore carries only what is safe in the open — liveness, build
 * identity, environment name, database reachability. Row counts and configuration
 * presence are the admin tier.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness, build identity and database reachability (public-safe)' })
  publicHealth() {
    return this.health.publicHealth();
  }

  @Get('deployment')
  @UseGuards(JwtAuthGuard, RbacGuard)
  @RequirePermission(PERMISSIONS.CONFIG_VIEW)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Deployment status for administrators: seed presence, customer/vehicle counts, configuration presence. Never values, never secrets.',
  })
  deploymentStatus() {
    return this.health.deploymentStatus();
  }
}
