import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn, IsInt, Min, Max, Matches } from 'class-validator';
import { Type } from 'class-transformer';

/** Admin/Manager customer directory (browse-all phonebook). CR-2026-021. */
export class CustomerDirectoryDto {
  @ApiPropertyOptional({ description: 'Optional free-text search (name/customer#/email/phone/vehicle)' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Single A–Z letter filter on last name' })
  @IsOptional()
  @Matches(/^[A-Za-z]$/, { message: 'letter must be a single A–Z character' })
  letter?: string;

  @ApiPropertyOptional({ enum: ['name', 'customerNumber', 'lastVisit'], default: 'name' })
  @IsOptional()
  @IsIn(['name', 'customerNumber', 'lastVisit'])
  sortBy?: 'name' | 'customerNumber' | 'lastVisit';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ description: "Loyalty customers only ('true')" })
  @IsOptional()
  @IsString()
  hasLoyalty?: string;

  @ApiPropertyOptional({ description: "Has at least one vehicle ('true')" })
  @IsOptional()
  @IsString()
  hasVehicle?: string;

  @ApiPropertyOptional({ description: "Missing usable phone AND email ('true')" })
  @IsOptional()
  @IsString()
  missingContact?: string;
}
