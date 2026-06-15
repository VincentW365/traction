import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, IsOptional, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { InspectionSignatureType } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * CR-2026-034 (C-3) — customer sign-off. DRAWN requires imageData; TYPED requires
 * typedName (cross-field rules re-checked in the service before any write).
 */
export class CustomerSignoffDto {
  @ApiProperty({ enum: InspectionSignatureType })
  @IsEnum(InspectionSignatureType)
  type!: InspectionSignatureType;

  @ApiPropertyOptional({ description: 'Typed name (required when type=TYPED)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  typedName?: string;

  @ApiPropertyOptional({ description: 'Base64 data-URL signature image (required when type=DRAWN)' })
  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  imageData?: string;
}
