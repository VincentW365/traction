import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class WalkInServiceItemDto {
  @ApiProperty({ description: 'Service type code (e.g., OIL_CHANGE)' })
  @IsString()
  @IsNotEmpty()
  serviceTypeCode!: string;

  @ApiPropertyOptional({ description: 'Quantity (defaults to 1)', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;

  @ApiPropertyOptional({ description: 'Notes for this service request' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateWalkInDto {
  @ApiProperty({ description: 'Site ID where the walk-in is registering' })
  @IsUUID()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ description: 'Customer ID' })
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @ApiProperty({ description: 'Vehicle ID' })
  @IsUUID()
  @IsNotEmpty()
  vehicleId!: string;

  @ApiProperty({
    description: 'Service types requested by the walk-in customer',
    type: [WalkInServiceItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WalkInServiceItemDto)
  serviceTypes!: WalkInServiceItemDto[];

  @ApiPropertyOptional({
    description: 'General notes for the walk-in visit',
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

  @ApiPropertyOptional({ description: 'Vehicle color (confirmation or entry)' })
  @IsOptional()
  @IsString()
  color?: string;
}
