import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsUUID, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { InspectionStatus } from '@prisma/client';

/** CR-2026-034 (C-2) — list/filter inspections. Non-ADMIN is forced to their own site in the service. */
export class InspectionQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID() siteId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID() serviceVisitId?: string;

  @ApiPropertyOptional({ enum: InspectionStatus })
  @IsOptional() @IsEnum(InspectionStatus) status?: InspectionStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) take?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip?: number;
}
