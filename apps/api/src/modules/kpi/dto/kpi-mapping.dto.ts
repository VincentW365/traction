import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
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

export const KPI_CONTRIBUTION_MODES = [
  'PACKAGE_COMPONENT',
  'INCLUDED_IN_BASE',
  'ADDITIVE_STANDARD',
  'SEPARATE_SLA',
  'CONDITIONAL',
  'CUSTOM_ONLY',
] as const;

export const KPI_DURATION_SOURCES = [
  'MANAGER_PACKAGE',
  'SERVICE_CATALOG_DURATION',
  'FIXED_CONFIGURED_DURATION',
  'NO_DURATION',
] as const;

export const KPI_ALLOWANCE_BASES = ['PER_JOB', 'PER_SERVICE_LINE', 'PER_UNIT'] as const;

export const KPI_REQUIRED_QUALIFIERS = ['NONE', 'BRAKE', 'TIRE_OPERATION'] as const;

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

  // CR-2026-092 — the contribution policy. Omitted fields carry forward from the row
  // being superseded, so changing one never silently resets the others.

  @ApiPropertyOptional({ enum: KPI_CONTRIBUTION_MODES })
  @IsOptional()
  @IsEnum(KPI_CONTRIBUTION_MODES as unknown as object)
  contributionMode?: (typeof KPI_CONTRIBUTION_MODES)[number];

  @ApiPropertyOptional({ enum: KPI_DURATION_SOURCES })
  @IsOptional()
  @IsEnum(KPI_DURATION_SOURCES as unknown as object)
  durationSource?: (typeof KPI_DURATION_SOURCES)[number];

  @ApiPropertyOptional({ enum: KPI_ALLOWANCE_BASES })
  @IsOptional()
  @IsEnum(KPI_ALLOWANCE_BASES as unknown as object)
  allowanceBasis?: (typeof KPI_ALLOWANCE_BASES)[number];

  @ApiPropertyOptional({ enum: KPI_REQUIRED_QUALIFIERS })
  @IsOptional()
  @IsEnum(KPI_REQUIRED_QUALIFIERS as unknown as object)
  requiredQualifier?: (typeof KPI_REQUIRED_QUALIFIERS)[number];

  @ApiPropertyOptional({
    description: 'Minutes when the duration source is FIXED_CONFIGURED_DURATION.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  fixedSedanMinutes?: number;

  @ApiPropertyOptional({
    description:
      'SUV minutes, only where management has approved a class split. Falls back to the sedan figure.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  fixedSuvMinutes?: number;

  @ApiPropertyOptional({
    description: 'Mark the duration as a stand-in awaiting management confirmation.',
  })
  @IsOptional()
  @IsBoolean()
  provisionalDuration?: boolean;

  @ApiPropertyOptional({
    description: 'Keep this code out of new bookings while historical lines stay resolvable.',
  })
  @IsOptional()
  @IsBoolean()
  isSupersededCode?: boolean;
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
