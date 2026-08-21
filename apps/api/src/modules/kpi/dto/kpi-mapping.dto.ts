import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * CR-2026-090 — administering the KPI package-component mapping, and correcting
 * technician work segments.
 */

export const KPI_COMPONENT_ROLES = [
  'GENERAL_SERVICE_CORE',
  'FRONT_BRAKES',
  'SPARK_PLUGS',
  'INCLUDED_NO_ADDITIONAL_BENCHMARK',
  'FORCES_CUSTOM_BENCHMARK',
] as const;

export class UpsertKpiMappingDto {
  @ApiProperty({ description: 'Service type this mapping applies to' })
  @IsUUID()
  serviceTypeId!: string;

  @ApiProperty({
    enum: KPI_COMPONENT_ROLES,
    description:
      'What this service means for benchmarking. INCLUDED_NO_ADDITIONAL_BENCHMARK marks work the ' +
      'general-service standard already covers; FORCES_CUSTOM_BENCHMARK marks work the approved ' +
      'packages do not describe.',
  })
  @IsEnum(KPI_COMPONENT_ROLES as unknown as object)
  componentRole!: (typeof KPI_COMPONENT_ROLES)[number];

  @ApiPropertyOptional({
    description:
      'Require the work-order line to state an axle before it can satisfy this component. ' +
      'Set for brake work, where front and rear are different jobs and the service code does not say which.',
  })
  @IsOptional()
  @IsBoolean()
  requiresAxleQualifier?: boolean;

  @ApiPropertyOptional({ description: 'Why this mapping was chosen — shown in the admin screen' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    description:
      'When the mapping takes effect. Defaults to now. Cannot be backdated — that would change what ' +
      'jobs already in progress are measured against.',
  })
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

export class DeactivateKpiMappingDto {
  @ApiPropertyOptional({ description: 'Why this mapping no longer applies' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class CorrectWorkSegmentDto {
  @ApiPropertyOptional({ description: 'Corrected start (ISO)' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({
    description: 'Corrected end (ISO). Pass null to reopen the segment.',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  endedAt?: string | null;

  // Required, not optional: a labour figure that can be edited without saying why is
  // not a labour figure anyone should be asked to trust.
  @ApiProperty({ description: 'Why the segment is being corrected. Required and audited.' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}
