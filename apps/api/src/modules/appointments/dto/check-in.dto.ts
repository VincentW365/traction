import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsDateString, IsString, IsInt, Min, MaxLength, IsBoolean, IsEnum } from 'class-validator';
import { VehicleServiceClass } from '@prisma/client';

export class CheckInDto {
  @ApiPropertyOptional({
    description:
      'Override arrival timestamp (ISO 8601). Defaults to server now if omitted.',
    example: '2026-04-15T09:05:00Z',
  })
  @IsOptional()
  @IsDateString()
  arrivalAt?: string;

  @ApiPropertyOptional({
    description: 'Check-in notes (e.g. customer remarks at arrival)',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  // --- v4.1 intake fields ---

  @ApiPropertyOptional({ description: 'Mileage at intake' })
  @IsOptional()
  @IsInt()
  @Min(0)
  mileageIn?: number;

  @ApiPropertyOptional({ description: 'Oil brand requested (Amsoil, Liqui Moly, etc.)' })
  @IsOptional()
  @IsString()
  oilBrand?: string;

  @ApiPropertyOptional({ description: 'Oil grade requested (5W-30, 0W-20, etc.)' })
  @IsOptional()
  @IsString()
  oilGrade?: string;

  @ApiPropertyOptional({ description: 'Vehicle weight class (LIGHT, STANDARD, HEAVY)' })
  @IsOptional()
  @IsString()
  vehicleWeightClass?: string;

  @ApiPropertyOptional({
    description:
      'Vehicle service class (SEDAN_CLASS, SUV_LIGHT, SUV_HEAVY, PICKUP, VAN, TRUCK, UNKNOWN_REQUIRES_REVIEW). Drives mobile-jack eligibility (DMAIC Rule 3).',
    enum: VehicleServiceClass,
  })
  @IsOptional()
  @IsEnum(VehicleServiceClass)
  vehicleServiceClass?: VehicleServiceClass;

  @ApiPropertyOptional({ description: 'Vehicle color (confirmation or entry)' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({
    description:
      'Manager override for the mileage gate (DMAIC Rule 5). Allows recording mileage on a non-service job, or omitting it on a service job. Audited.',
  })
  @IsOptional()
  @IsBoolean()
  mileageOverride?: boolean;

  @ApiPropertyOptional({ description: 'Reason for the mileage manager override (recorded in audit)' })
  @IsOptional()
  @IsString()
  overrideReason?: string;

  // --- P4(b) notification consent capture (default opt-out; persisted + audited) ---

  @ApiPropertyOptional({ description: 'Customer consents to SMS notifications' })
  @IsOptional()
  @IsBoolean()
  notificationOptInSms?: boolean;

  @ApiPropertyOptional({ description: 'Customer consents to email notifications' })
  @IsOptional()
  @IsBoolean()
  notificationOptInEmail?: boolean;
}
