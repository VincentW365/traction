import {
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { WalkInsService } from './walk-ins.service';
import { CreateWalkInDto } from './dto/create-walk-in.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RbacGuard } from '../../common/guards/rbac.guard';
import { SiteGuard } from '../../common/guards/site.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, type JwtPayload } from '../../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../../common/constants/permissions';

@ApiTags('Walk-Ins')
@Controller('walk-ins')
@UseGuards(JwtAuthGuard, RbacGuard)
@ApiBearerAuth()
export class WalkInsController {
  constructor(private walkInsService: WalkInsService) {}

  @Post()
  @UseGuards(SiteGuard)
  @RequirePermission(PERMISSIONS.WALKIN_CREATE)
  @ApiOperation({
    summary: 'Register a walk-in customer visit',
    description:
      'Creates a ServiceVisit for a walk-in customer, generates a queue ticket, ' +
      'and returns the visit with a PENDING priority class until the scheduler runs.',
  })
  async register(
    @Body() dto: CreateWalkInDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.walkInsService.register(dto, user.sub);
  }
}
