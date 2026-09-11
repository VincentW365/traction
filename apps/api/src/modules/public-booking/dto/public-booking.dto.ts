import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * CR-2026-105c — public booking DTOs. Every public body/query is validated by the
 * global ValidationPipe (whitelist + forbidNonWhitelisted), so nothing beyond
 * these fields reaches the service.
 */

export class IdentifyDto {
  @ApiProperty({ description: 'Mobile number as the customer knows it' })
  @IsString() @IsNotEmpty() @MaxLength(30)
  phone!: string;

  @ApiProperty({ description: 'Licence plate' })
  @IsString() @IsNotEmpty() @MaxLength(20)
  plateNumber!: string;
}

export class AvailabilityQueryDto {
  @ApiProperty({ description: 'Comma-separated service codes' })
  @IsString() @IsNotEmpty() @MaxLength(200)
  serviceCodes!: string;

  @ApiPropertyOptional({ description: 'First day to show, YYYY-MM-DD (site local); defaults to today' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'Days to show (capped by the advance window)', default: 14 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60)
  days?: number;
}

export class NewCustomerDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(80)
  firstName!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(80)
  lastName!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(30)
  phone!: string;

  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(120)
  email?: string;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean()
  smsOptIn?: boolean;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean()
  emailOptIn?: boolean;
}

export class NewVehicleDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(20)
  plateNumber!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60)
  make?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60)
  model?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(2100)
  modelYear?: number;
}

export class ConfirmBookingDto {
  @ApiPropertyOptional({ description: 'Session token from /identify (existing customer)' })
  @IsOptional() @IsString() @MaxLength(2000)
  sessionToken?: string;

  @ApiPropertyOptional({ type: NewCustomerDto, description: 'New customer (when no session token)' })
  @IsOptional() @ValidateNested() @Type(() => NewCustomerDto)
  customer?: NewCustomerDto;

  @ApiPropertyOptional({ format: 'uuid', description: 'One of the identified customer\'s vehicles' })
  @IsOptional() @IsUUID()
  vehicleId?: string;

  @ApiPropertyOptional({ type: NewVehicleDto })
  @IsOptional() @ValidateNested() @Type(() => NewVehicleDto)
  vehicle?: NewVehicleDto;

  @ApiProperty({ type: [String] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @IsString({ each: true })
  serviceCodes!: string[];

  @ApiProperty({ description: 'Chosen slot start (ISO 8601)' })
  @IsDateString()
  scheduledStartAt!: string;
}

export class CancelBookingDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300)
  reason?: string;
}

export class RescheduleBookingDto {
  @ApiProperty({ description: 'New slot start (ISO 8601)' })
  @IsDateString()
  scheduledStartAt!: string;
}
