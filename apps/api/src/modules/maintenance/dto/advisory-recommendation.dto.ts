import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';

export class AdvisoryRecommendationQueryDto {
  @ApiProperty({
    description: 'Service type code (e.g. OIL_CHANGE)',
    example: 'OIL_CHANGE',
  })
  @IsString()
  @IsNotEmpty()
  serviceTypeCode!: string;

  @ApiPropertyOptional({
    description: 'Driving profile — NORMAL or SEVERE',
    enum: ['NORMAL', 'SEVERE'],
    default: 'NORMAL',
  })
  @IsOptional()
  @IsIn(['NORMAL', 'SEVERE'])
  drivingProfile?: 'NORMAL' | 'SEVERE';
}
