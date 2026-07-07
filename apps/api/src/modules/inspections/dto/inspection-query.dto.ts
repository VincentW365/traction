import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsUUID, IsInt, Min, Max, IsString, IsBoolean, IsDateString, MaxLength } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { InspectionStatus, RecommendationSeverity } from '@prisma/client';

/**
 * CR-2026-034 (C-2) — list/filter inspections. Non-ADMIN is forced to their own
 * site in the service. CR-2026-081 adds active/history, per-customer archive, a
 * date range, free-text search and a severity filter (all staff-only).
 */
export class InspectionQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID() siteId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID() serviceVisitId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter to one customer (per-customer inspection archive)' })
  @IsOptional() @IsUUID() customerId?: string;

  @ApiPropertyOptional({ enum: InspectionStatus })
  @IsOptional() @IsEnum(InspectionStatus) status?: InspectionStatus;

  @ApiPropertyOptional({ description: 'Active-only shortcut (DRAFT/COMPLETED/SIGNED_OFF); ignored if status is set' })
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() active?: boolean;

  @ApiPropertyOptional({ description: 'Inclusive from-date (YYYY-MM-DD), on the created date' })
  @IsOptional() @IsDateString() dateFrom?: string;

  @ApiPropertyOptional({ description: 'Inclusive to-date (YYYY-MM-DD), on the created date' })
  @IsOptional() @IsDateString() dateTo?: string;

  @ApiPropertyOptional({ description: 'Free-text search: inspection #, customer name, plate' })
  @IsOptional() @IsString() @MaxLength(100) q?: string;

  @ApiPropertyOptional({ enum: RecommendationSeverity, description: 'Only inspections with a finding of this severity' })
  @IsOptional() @IsEnum(RecommendationSeverity) severity?: RecommendationSeverity;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) take?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) skip?: number;
}
