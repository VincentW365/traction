import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class VehicleSearchDto {
  @ApiProperty({
    description: 'Search query — matches plate number, VIN, or customer name',
    minLength: 2,
    example: 'ABC',
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
