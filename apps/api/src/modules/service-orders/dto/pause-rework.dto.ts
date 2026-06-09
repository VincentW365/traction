import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsNotEmpty } from 'class-validator';
import { PauseReason } from '@prisma/client';

export class PauseServiceOrderDto {
  @ApiProperty({
    description: 'Why the job is being paused',
    enum: PauseReason,
    example: 'WAITING_TECH',
  })
  @IsEnum(PauseReason)
  reasonCode!: PauseReason;

  @ApiPropertyOptional({ description: 'Free-text notes about the pause' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ResumeServiceOrderDto {
  @ApiPropertyOptional({ description: 'Free-text notes about the resume' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ReworkServiceOrderDto {
  @ApiProperty({
    description: 'Reason the job is sent back for rework (QC failure)',
    example: 'QC_FAIL_BRAKES',
  })
  @IsString()
  @IsNotEmpty()
  reasonCode!: string;

  @ApiPropertyOptional({ description: 'What needs to be re-done' })
  @IsOptional()
  @IsString()
  description?: string;
}
