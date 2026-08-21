import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Min, MaxLength, MinLength } from 'class-validator';

/**
 * CR-2026-088 — a manager-approved standard for a job the benchmark does not cover.
 *
 * The reason is mandatory because this number is what a technician will be measured
 * against, and "because someone typed it" is not an auditable basis. It must be set
 * before the job finishes; the service refuses once the snapshot is finalised, since
 * setting a benchmark after seeing a poor result is the manipulation the audit trail
 * exists to prevent.
 */
export class ApproveCustomStandardDto {
  @ApiProperty({ description: 'Standard time in whole minutes', minimum: 1 })
  @IsInt()
  @Min(1)
  standardMinutes!: number;

  @ApiProperty({ description: 'Why this standard is appropriate for this job' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}
