import { IsString, IsOptional, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * CR-2026-018 (P3) — mark an active ServiceVisit as ABANDONED (no-show /
 * left before service). A reason is REQUIRED for the audit trail.
 */
export class AbandonVisitDto {
  @ApiProperty({
    description: 'Reason code for the abandonment',
    example: 'NO_SHOW',
  })
  @IsString()
  @IsNotEmpty()
  reasonCode!: string;

  @ApiPropertyOptional({ description: 'Free-text note explaining the abandonment' })
  @IsOptional()
  @IsString()
  notes?: string;
}
