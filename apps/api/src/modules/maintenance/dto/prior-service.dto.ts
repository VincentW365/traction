import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsDateString,
  IsIn,
  Min,
} from 'class-validator';

export class PriorServiceDto {
  @ApiProperty({
    description: 'Service type code (e.g. OIL_CHANGE)',
    example: 'OIL_CHANGE',
  })
  @IsString()
  @IsNotEmpty()
  serviceTypeCode!: string;

  @ApiPropertyOptional({
    description: 'Odometer at the time of the prior service (miles)',
    example: 40000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  lastServiceOdometer?: number;

  @ApiPropertyOptional({ description: 'Date of the prior service (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  lastServiceDate?: string;

  @ApiProperty({
    description: 'Source of the prior service information (e.g. CUSTOMER_REPORTED, CARFAX)',
    example: 'CUSTOMER_REPORTED',
  })
  @IsString()
  @IsNotEmpty()
  source!: string;

  @ApiPropertyOptional({
    description: 'Driving profile — NORMAL or SEVERE',
    enum: ['NORMAL', 'SEVERE'],
    default: 'NORMAL',
  })
  @IsOptional()
  @IsIn(['NORMAL', 'SEVERE'])
  drivingProfile?: 'NORMAL' | 'SEVERE';
}
