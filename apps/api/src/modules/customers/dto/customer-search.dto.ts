import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class CustomerSearchDto {
  @ApiProperty({
    description: 'Search query — matches phone, name, or customer number',
    minLength: 2,
  })
  @IsString()
  @MinLength(2)
  q!: string;

  @ApiPropertyOptional({
    description:
      'Include historical/placeholder records (default false). CR-2026-006.',
    type: Boolean,
  })
  @IsOptional()
  @IsString()
  includeHistorical?: string;
}
