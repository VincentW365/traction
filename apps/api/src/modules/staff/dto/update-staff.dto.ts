import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const VALID_ROLES = [
  'ADMIN',
  'MANAGER',
  'SERVICE_ADVISOR',
  'FRONT_DESK',
  'TECHNICIAN',
  'PARTS_STAFF',
  'TRANSPORT_COORDINATOR',
];

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
