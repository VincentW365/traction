import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateTransportRequestDto {
  @ApiProperty({ description: 'Service visit to associate transport with' })
  @IsUUID()
  @IsNotEmpty()
  serviceVisitId!: string;

  @ApiProperty({ enum: ['DROPOFF', 'PICKUP'] })
  @IsEnum(['DROPOFF', 'PICKUP'])
  direction!: 'DROPOFF' | 'PICKUP';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  originAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  destinationAddress?: string;

  @ApiPropertyOptional({ description: 'Requested pickup time (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  requestedPickupAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
