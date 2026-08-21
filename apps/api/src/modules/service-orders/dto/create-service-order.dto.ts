import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsUUID,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsEnum,
  IsString,
  IsInt,
  IsDateString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const AXLE_POSITIONS = ['FRONT', 'REAR', 'FRONT_AND_REAR', 'NOT_APPLICABLE'] as const;

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

  /**
   * CR-2026-090 — which axle this line covers.
   *
   * Needed because the shop's price list distinguishes front from rear explicitly
   * (separate lines for disc pads and rear electronic disc pads, plus brake shoes for
   * drums) while Traction's service codes carry no axle at all. Without it a brake
   * line is ambiguous, and rear-only work would silently satisfy a benchmark built
   * for front brakes.
   *
   * Optional at this boundary: only services an administrator has marked as needing
   * a qualifier actually require it, and that is configuration rather than something
   * this DTO can know.
   */
  @ApiPropertyOptional({
    enum: AXLE_POSITIONS,
    description:
      'Which axle this line covers. Required for services configured to need an axle qualifier (brake work).',
  })
  @IsOptional()
  @IsEnum(AXLE_POSITIONS as unknown as object)
  axlePosition?: (typeof AXLE_POSITIONS)[number];
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
