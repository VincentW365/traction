import {
  IsString,
  IsOptional,
  IsInt,
  IsDateString,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class QueueOverrideDto {
  @ApiProperty({ description: 'Reason code for the override' })
  @IsString()
  reasonCode!: string;

  @ApiProperty({ description: 'Target FIFO position (1-based)', example: 1 })
  @IsInt()
  @Min(1)
  targetPosition!: number;

  @ApiProperty({ description: 'Override expiry (ISO datetime)', required: false })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiProperty({ description: 'Additional notes', required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ClearOverrideDto {
  @ApiProperty({ description: 'Reason for clearing', required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}
