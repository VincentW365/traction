import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, IsOptional, IsDateString } from 'class-validator';

export class CreateTransferDto {
  @ApiProperty({ description: 'Parts request this transfer fulfils' })
  @IsUUID()
  @IsNotEmpty()
  partsRequestId!: string;

  @ApiProperty({ description: 'Site shipping the parts' })
  @IsUUID()
  @IsNotEmpty()
  sourceSiteId!: string;

  @ApiProperty({ description: 'Site receiving the parts' })
  @IsUUID()
  @IsNotEmpty()
  destinationSiteId!: string;

  @ApiPropertyOptional({
    description: 'Estimated arrival time (ISO 8601)',
    example: '2026-04-15T14:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  etaAt?: string;
}
