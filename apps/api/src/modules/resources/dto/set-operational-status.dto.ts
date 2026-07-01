import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * CR-2026-065 — validate the resource operational up/down toggle body (was an
 * unvalidated inline object).
 */
export class SetOperationalStatusDto {
  @ApiProperty({ description: 'true = operational (up); false = down for maintenance' })
  @IsBoolean()
  isOperational!: boolean;

  @ApiPropertyOptional({ description: 'Reason (e.g. why it is down)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
