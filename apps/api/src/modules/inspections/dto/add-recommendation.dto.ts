import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, IsNotEmpty, IsOptional, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { RecommendationSeverity } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** CR-2026-034 (C-2) — add a finding/recommendation to a DRAFT inspection. */
export class AddRecommendationDto {
  @ApiProperty({ enum: RecommendationSeverity })
  @IsEnum(RecommendationSeverity)
  severity!: RecommendationSeverity;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Source checklist line, if any' })
  @IsOptional()
  @IsUUID()
  inspectionItemId?: string;

  @ApiPropertyOptional({ description: 'Suggested service type code for follow-up work (C-5)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  suggestedServiceTypeCode?: string;
}
