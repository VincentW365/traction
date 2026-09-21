import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from './config.service';
import { UpdateRuleConfigDto } from './dto/update-rule-config.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';
import {
  CurrentUser,
  type JwtPayload,
} from '../../common/decorators/current-user.decorator';

@ApiTags('Config')
@Controller('config')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class ConfigController {
  constructor(private configService: ConfigService) {}

  @Get('business-rules')
  @RequirePermission(PERMISSIONS.CONFIG_VIEW)
  @ApiOperation({ summary: 'List all active business rule configurations' })
  async listRules(@Query('siteId') siteId?: string) {
    return this.configService.listRules(siteId);
  }

  @Patch('business-rules/:ruleKey')
  @RequirePermission(PERMISSIONS.CONFIG_EDIT)
  @ApiOperation({ summary: 'Update a business rule configuration value' })
  async updateRule(
    @Param('ruleKey') ruleKey: string,
    @Query('siteId') siteId: string,
    @Body() dto: UpdateRuleConfigDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.configService.updateRule(
      ruleKey,
      siteId,
      dto.value,
      user.sub,
      dto.effectiveFrom,
      dto.notes,
    );
  }

  @Get('business-rules/:ruleKey/history')
  @RequirePermission(PERMISSIONS.CONFIG_VIEW)
  @ApiOperation({ summary: 'Get version history for a business rule' })
  async getRuleHistory(
    @Param('ruleKey') ruleKey: string,
    @Query('siteId') siteId?: string,
  ) {
    return this.configService.getRuleHistory(ruleKey, siteId);
  }
}
