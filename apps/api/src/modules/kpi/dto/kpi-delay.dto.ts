import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * CR-2026-088 — controlled delay reasons.
 *
 * Deliberately excludes ordinary work difficulty, tool searching, poor preparation
 * and rework: those are the technician's own time and must stay in the measurement,
 * or the KPI stops meaning anything.
 */
export const KPI_DELAY_REASONS = [
  'WAITING_FOR_PARTS',
  'WAITING_CUSTOMER_AUTHORIZATION',
  'BAY_OR_EQUIPMENT_UNAVAILABLE',
  'MANAGER_OR_QC_HOLD',
  'SYSTEM_OUTAGE',
  'SAFETY_HOLD',
  'EXCEPTIONAL_THERMAL_SAFETY_HOLD',
  'TECHNICIAN_REASSIGNMENT',
  'OTHER',
] as const;

export class RecordDelayDto {
  @ApiProperty({ enum: KPI_DELAY_REASONS })
  @IsEnum(KPI_DELAY_REASONS as unknown as object)
  reasonCode!: (typeof KPI_DELAY_REASONS)[number];

  @ApiPropertyOptional({
    description:
      'Required in practice for OTHER and for an exceptional thermal safety hold — a supervisor cannot judge an exclusion without it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ description: 'ISO timestamp the delay began' })
  @IsDateString()
  startedAt!: string;

  @ApiPropertyOptional({ description: 'ISO timestamp the delay ended; omit while ongoing' })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({
    description:
      'Ask for this time to be excluded from the technician KPI. Stays PENDING until a supervisor decides.',
  })
  @IsOptional()
  @IsBoolean()
  requestedForExclusion?: boolean;

  @ApiPropertyOptional({ description: 'Technician the delay belongs to' })
  @IsOptional()
  @IsUUID()
  technicianId?: string;
}

export class DecideDelayDto {
  @ApiProperty({ description: 'true to approve the exclusion, false to reject it' })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({ description: 'Required when rejecting' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rejectionReason?: string;
}
