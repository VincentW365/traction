import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsString, IsOptional, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { InspectionSignatureType } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * CR-2026-034 (C-3) / CR-2026-046 — senior-tech sign-off. Mirrors CustomerSignoffDto:
 * DRAWN requires imageData; TYPED requires typedName. `type` is optional and
 * defaults to TYPED in the service (back-compat with existing `{ typedName }` callers).
 * Identity is always taken from the JWT (signedByUserId).
 */
export class SignoffInspectionDto {
  @ApiPropertyOptional({ enum: InspectionSignatureType, description: 'Defaults to TYPED when omitted' })
  @IsOptional()
  @IsEnum(InspectionSignatureType)
  type?: InspectionSignatureType;

  @ApiPropertyOptional({ description: 'Typed acknowledgment name (required when type=TYPED)' })
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
