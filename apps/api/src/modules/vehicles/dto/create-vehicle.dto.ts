import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsInt,
  IsNotEmpty,
  Min,
} from 'class-validator';

export class CreateVehicleDto {
  @ApiProperty({ description: 'ID of the owning customer', format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @ApiProperty({ description: 'Vehicle license plate number' })
  @IsString()
  @IsNotEmpty()
  plateNumber!: string;

  @ApiPropertyOptional({ description: 'Chassis Number/VIN (unique when provided)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  vin?: string;

  @ApiPropertyOptional({ description: 'Vehicle make (e.g. Toyota)' })
  @IsOptional()
  @IsString()
  make?: string;

  @ApiPropertyOptional({ description: 'Vehicle model (e.g. Camry)' })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ description: 'Model year', example: 2023 })
  @IsOptional()
  @IsInt()
  @Min(1900)
  modelYear?: number;

  @ApiPropertyOptional({ description: 'Vehicle color' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ description: 'Current odometer reading in km', example: 45000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  odometer?: number;
}
