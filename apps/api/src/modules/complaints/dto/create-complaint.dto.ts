import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsEnum, IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ComplaintType, ComplaintSeverity } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** CR-2026-032 — log a new customer complaint. Whitelisted: never accepts status/number/actor ids. */
export class CreateComplaintDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @ApiProperty({ enum: ComplaintType })
  @IsEnum(ComplaintType)
  type!: ComplaintType;

  @ApiPropertyOptional({ enum: ComplaintSeverity, default: 'MEDIUM' })
  @IsOptional()
  @IsEnum(ComplaintSeverity)
  severity?: ComplaintSeverity;

  @ApiProperty({ description: 'Short title' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject!: string;

  @ApiProperty({ description: 'Full complaint text' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  description!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Optional linked service visit' })
  @IsOptional()
  @IsUUID()
  serviceVisitId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Optional linked service order' })
  @IsOptional()
  @IsUUID()
  serviceOrderId?: string;
}
