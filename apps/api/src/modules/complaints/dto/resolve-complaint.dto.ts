import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * CR-2026-032 — resolve a complaint. resolutionNotes is REQUIRED and trimmed:
 * the @Transform runs before @IsNotEmpty, so whitespace-only is rejected (400).
 * The service re-checks the trimmed value before any write as a second guard.
 */
export class ResolveComplaintDto {
  @ApiProperty({ description: 'Manager-internal resolution notes (required)' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  resolutionNotes!: string;
}
