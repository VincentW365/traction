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

export class OverrideRecommendationDto {
  @ApiPropertyOptional({ description: 'Override next due odometer (miles)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  nextDueOdometer?: number;

  @ApiPropertyOptional({ description: 'Override next due date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  nextDueDate?: string;

  @ApiPropertyOptional({
    description: 'Override interval miles',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMiles?: number;

  @ApiPropertyOptional({
    description: 'Override interval months',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMonths?: number;

  @ApiPropertyOptional({
    description: 'Driving profile override',
    enum: ['NORMAL', 'SEVERE'],
  })
  @IsOptional()
  @IsIn(['NORMAL', 'SEVERE'])
  drivingProfile?: 'NORMAL' | 'SEVERE';

  @ApiProperty({
    description: 'Reason for the override — required for audit trail',
  })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
