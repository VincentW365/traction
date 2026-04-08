import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsUUID,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsString,
  IsInt,
  IsDateString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ServiceOrderItemDto {
  @ApiProperty({ description: 'Service type code (e.g., OIL_CHANGE)' })
  @IsString()
  @IsNotEmpty()
  serviceTypeCode!: string;

  @ApiPropertyOptional({ description: 'Estimated minutes for this service' })
  @IsOptional()
  @IsInt()
  @Min(1)
  estimateMinutes?: number;

  @ApiPropertyOptional({ description: 'Notes for this line item' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateServiceOrderDto {
  @ApiProperty({ description: 'Service visit ID this order belongs to' })
  @IsUUID()
  @IsNotEmpty()
  serviceVisitId!: string;

  @ApiProperty({
    description: 'Service line items to include in the order',
    type: [ServiceOrderItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ServiceOrderItemDto)
  items!: ServiceOrderItemDto[];

  @ApiPropertyOptional({
    description: 'Promised completion time (ISO 8601 datetime string)',
    example: '2026-04-15T16:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  promisedCompletionAt?: string;

  @ApiPropertyOptional({ description: 'General notes for this service order' })
  @IsOptional()
  @IsString()
  notes?: string;
}
