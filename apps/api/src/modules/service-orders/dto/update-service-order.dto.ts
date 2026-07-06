import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsArray, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ServiceOrderItemDto } from './create-service-order.dto';

/**
 * CR-2026-071 — edit a service order before work is assigned. Replaces the order's
 * line items (when provided) and/or its notes. Guarded server-side to DRAFT/APPROVED.
 */
export class UpdateServiceOrderDto {
  @ApiPropertyOptional({ description: 'Replacement line items (service codes)', type: [ServiceOrderItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ServiceOrderItemDto)
  items?: ServiceOrderItemDto[];

  @ApiPropertyOptional({ description: 'General notes for the service order' })
  @IsOptional()
  @IsString()
  notes?: string;
}
