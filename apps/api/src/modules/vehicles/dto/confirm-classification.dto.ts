import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { VehicleServiceClass, VehicleWeightClass } from '@prisma/client';

/**
 * CR-2026-008 — staff confirmation of a vehicle's operational serviceClass.
 * The chosen serviceClass is the value that becomes operational (drives Rule 3).
 */
export class ConfirmClassificationDto {
  @ApiProperty({ enum: VehicleServiceClass })
  @IsEnum(VehicleServiceClass)
  serviceClass!: VehicleServiceClass;

  @ApiPropertyOptional({ enum: VehicleWeightClass })
  @IsOptional()
  @IsEnum(VehicleWeightClass)
  weightClass?: VehicleWeightClass;

  @ApiPropertyOptional({ description: 'Optional reviewer note (audited).' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
