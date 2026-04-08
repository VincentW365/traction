import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsInt, IsIn, IsOptional, Min } from 'class-validator';

export class PostServiceRecommendationDto {
  @ApiProperty({
    description: 'Service type code (e.g. OIL_CHANGE)',
    example: 'OIL_CHANGE',
  })
  @IsString()
  @IsNotEmpty()
  serviceTypeCode!: string;

  @ApiProperty({
    description: 'Odometer reading at service completion (miles)',
    example: 45000,
  })
  @IsInt()
  @Min(0)
  completionOdometer!: number;

  @ApiPropertyOptional({
    description: 'Driving profile — NORMAL or SEVERE',
    enum: ['NORMAL', 'SEVERE'],
    default: 'NORMAL',
  })
  @IsOptional()
  @IsIn(['NORMAL', 'SEVERE'])
  drivingProfile?: 'NORMAL' | 'SEVERE';
}
