import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PauseReason } from '@prisma/client';

/** CR-2026-100 — rejecting a technician's pause request always states why. */
export class RejectPauseDto {
  @ApiProperty({ description: 'Why the pause is rejected / returned for clarification' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

/**
 * CR-2026-100 — controlled retroactive correction of when a pause took effect.
 * The effective start can only move EARLIER than the recorded press; the
 * original timestamp is preserved and the change is reasoned and audited.
 */
export class CorrectPauseStartDto {
  @ApiProperty({ description: 'The true moment work stopped (ISO date-time)' })
  @IsDateString()
  effectiveFrom!: string;

  @ApiProperty({ description: 'Why the recorded time is being corrected' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

/**
 * CR-2026-100 — starting work while still on the clock for another job requires
 * an explicit switch: the previous job is held with a stated reason (or, when
 * colleagues are still working it, only this technician's labour clock closes).
 */
export class StartAssignmentDto {
  @ApiPropertyOptional({
    description: 'Hold the job currently being worked with this reason, then switch',
    enum: PauseReason,
  })
  @IsOptional()
  @IsEnum(PauseReason)
  holdReasonCode?: PauseReason;

  @ApiPropertyOptional({ description: 'Note for the held job' })
  @IsOptional()
  @IsString()
  holdNotes?: string;
}
