import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsDateString, IsString, IsInt, Min, MaxLength } from 'class-validator';

export class CheckInDto {
  @ApiPropertyOptional({
    description:
      'Override arrival timestamp (ISO 8601). Defaults to server now if omitted.',
    example: '2026-04-15T09:05:00Z',
  })
  @IsOptional()
  @IsDateString()
  arrivalAt?: string;

  @ApiPropertyOptional({
    description: 'Check-in notes (e.g. customer remarks at arrival)',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  // --- v4.1 intake fields ---

  @ApiPropertyOptional({ description: 'Mileage at intake' })
  @IsOptional()
  @IsInt()
  @Min(0)
  mileageIn?: number;

  @ApiPropertyOptional({ description: 'Oil brand requested (Amsoil, Liqui Moly, etc.)' })
  @IsOptional()
  @IsString()
  oilBrand?: string;

  @ApiPropertyOptional({ description: 'Oil grade requested (5W-30, 0W-20, etc.)' })
  @IsOptional()
  @IsString()
  oilGrade?: string;

  @ApiPropertyOptional({ description: 'Vehicle weight class (LIGHT, STANDARD, HEAVY)' })
  @IsOptional()
  @IsString()
  vehicleWeightClass?: string;
}
