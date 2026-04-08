import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, IsInt, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class DueVehiclesQueryDto {
  @ApiProperty({ description: 'Site ID to scope the query', format: 'uuid' })
  @IsUUID()
  siteId!: string;

  @ApiPropertyOptional({
    description: 'Miles threshold — vehicles within this many miles of next due',
    default: 500,
    example: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => (value != null ? parseInt(value, 10) : undefined))
  thresholdMiles?: number;

  @ApiPropertyOptional({
    description: 'Days threshold — vehicles within this many days of next due',
    default: 30,
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Transform(({ value }) => (value != null ? parseInt(value, 10) : undefined))
  thresholdDays?: number;
}
