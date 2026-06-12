import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { DevLoginDto } from './dto/dev-login.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Authenticate and receive JWT tokens' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  async me(@CurrentUser() user: JwtPayload) {
    return this.authService.getProfile(user.sub);
  }

  // CR-2026-022 — dev-only one-click login (no guard: pre-auth; gated inside the
  // service by ALLOW_DEV_LOGIN + non-production). Refuses (403) when disabled.
  @Get('dev-login/profiles')
  @ApiOperation({ summary: 'Dev-only: list role profiles (gated; disabled in production)' })
  async devLoginProfiles() {
    return this.authService.listDevProfiles();
  }

  @Post('dev-login')
  @ApiOperation({ summary: 'Dev-only: one-click sign in as a role (gated; disabled in production)' })
  async devLogin(@Body() dto: DevLoginDto) {
    return this.authService.devLogin(dto.role);
  }

  // CR-2026-023 — dev sandbox session cleanup (current session only; gated inside the service).
  @Post('dev-sandbox/cleanup/preview')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dev-only: preview cleanup of the CURRENT sandbox session (no deletes)' })
  async devSandboxCleanupPreview(@CurrentUser() user: JwtPayload) {
    return this.authService.devSandboxCleanupPreview(user);
  }

  @Post('dev-sandbox/cleanup')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dev-only: clean up the CURRENT sandbox session (typed confirmation required)' })
  async devSandboxCleanup(@Body('confirm') confirm: string, @CurrentUser() user: JwtPayload) {
    return this.authService.devSandboxCleanup(user, confirm);
  }
}
