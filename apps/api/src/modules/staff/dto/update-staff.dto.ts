import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// CR-2026-048 — consolidated staff roles (ADMIN="Manager", SERVICE_ADVISOR, TECHNICIAN).
const VALID_ROLES = ['ADMIN', 'SERVICE_ADVISOR', 'TECHNICIAN'];

export class UpdateStaffDto {
  @ApiPropertyOptional({ description: 'Full name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @ApiPropertyOptional({ description: 'Email address' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Role code', enum: VALID_ROLES })
  @IsOptional()
  @IsString()
  @IsIn(VALID_ROLES)
  roleCode?: string;
}
