import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class FluidRecommendationQueryDto {
  @ApiProperty({
    description: 'Service type code (e.g. OIL_CHANGE)',
    example: 'OIL_CHANGE',
  })
  @IsString()
  @IsNotEmpty()
  serviceTypeCode!: string;
}
