import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class DecodeVehicleDto {
  @ApiPropertyOptional({
    description: 'Force re-decode even if a snapshot already exists',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  forceRedecode?: boolean;
}
