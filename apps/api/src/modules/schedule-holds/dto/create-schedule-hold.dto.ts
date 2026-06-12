import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, IsDateString, IsInt, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** CR-2026-026 — create an advisory schedule hold (no customer/vehicle/service). */
export class CreateScheduleHoldDto {
  @ApiProperty({ description: 'Site ID where the slot is held' })
  @IsUUID()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ description: 'Hold start time (ISO 8601 datetime string)', example: '2026-06-12T14:00:00Z' })
  @IsDateString()
  @IsNotEmpty()
  scheduledStartAt!: string;

  @ApiProperty({ description: 'Hold duration in minutes', enum: [30, 60, 90], example: 30 })
  @IsInt()
  @IsIn([30, 60, 90])
  durationMinutes!: number;

  @ApiPropertyOptional({ description: 'Optional short label (e.g. "Oil change - walk-up")' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({ description: 'Optional notes' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
