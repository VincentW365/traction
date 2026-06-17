import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

// CR-2026-048 — consolidated staff roles (ADMIN="Manager", SERVICE_ADVISOR, TECHNICIAN).
const VALID_ROLES = ['ADMIN', 'SERVICE_ADVISOR', 'TECHNICIAN'];

export class CreateStaffDto {
  @ApiProperty({ description: 'Full name of the staff member' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName!: string;

  @ApiPropertyOptional({ description: 'Email address' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ description: 'Role code', enum: VALID_ROLES })
  @IsString()
  @IsIn(VALID_ROLES)
  roleCode!: string;

  @ApiProperty({ description: 'Temporary password for initial login' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  temporaryPassword!: string;

  @ApiPropertyOptional({ description: 'Site ID (defaults to actor site)' })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @ApiPropertyOptional({ description: 'Employee code (for technicians)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  employeeCode?: string;
}
