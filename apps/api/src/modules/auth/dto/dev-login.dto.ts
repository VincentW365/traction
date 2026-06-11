import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { DEV_LOGIN_ROLES } from '../dev-login-profiles';

/** Dev-only login body. CUSTOMER + unknown roles are rejected here (and in the service). */
export class DevLoginDto {
  @ApiProperty({ enum: DEV_LOGIN_ROLES, description: 'Role to sign in as (dev-only)' })
  @IsIn(DEV_LOGIN_ROLES, { message: 'Unsupported dev-login role' })
  role!: string;
}
