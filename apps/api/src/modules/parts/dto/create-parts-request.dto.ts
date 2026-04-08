import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsUUID,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsString,
  IsInt,
  IsBoolean,
  IsDateString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PartsRequestItemDto {
  @ApiProperty({ description: 'Part SKU / catalog number' })
  @IsString()
  @IsNotEmpty()
  sku!: string;

  @ApiPropertyOptional({ description: 'Human-readable part description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Quantity requested', minimum: 1 })
  @IsInt()
  @Min(1)
  qtyRequested!: number;

  @ApiPropertyOptional({
    description: 'Whether this part is critical (blocks service start)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  criticalFlag?: boolean;
}

export class CreatePartsRequestDto {
  @ApiProperty({ description: 'Service order this parts request belongs to' })
  @IsUUID()
  @IsNotEmpty()
  serviceOrderId!: string;

  @ApiProperty({
    description: 'Parts items to request',
    type: [PartsRequestItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PartsRequestItemDto)
  items!: PartsRequestItemDto[];

  @ApiPropertyOptional({
    description: 'Date/time parts are required by (ISO 8601)',
    example: '2026-04-15T08:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  requiredByAt?: string;

  @ApiPropertyOptional({ description: 'Additional notes for parts staff' })
  @IsOptional()
  @IsString()
  notes?: string;
}
