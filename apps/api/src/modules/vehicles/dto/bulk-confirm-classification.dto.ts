import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { VehicleServiceClass, VehicleWeightClass } from '@prisma/client';

/**
 * CR-2026-008 — one explicit, staff-reviewed item. Each row carries the class
 * the reviewer chose; there is no blanket auto-acceptance of suggestions.
 */
export class BulkConfirmItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  vehicleId!: string;

  @ApiProperty({ enum: VehicleServiceClass })
  @IsEnum(VehicleServiceClass)
  serviceClass!: VehicleServiceClass;

  @ApiPropertyOptional({ enum: VehicleWeightClass })
  @IsOptional()
  @IsEnum(VehicleWeightClass)
  weightClass?: VehicleWeightClass;
}

export class BulkConfirmClassificationDto {
  @ApiProperty({ type: [BulkConfirmItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => BulkConfirmItemDto)
  items!: BulkConfirmItemDto[];
}
