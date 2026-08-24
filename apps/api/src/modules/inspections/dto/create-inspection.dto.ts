import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsEnum } from 'class-validator';
import { InspectionKind } from '@prisma/client';

/** CR-2026-034 (C-2) — start a DRAFT inspection for a service visit (site/vehicle/customer derived from the visit). */
export class CreateInspectionDto {
  @ApiProperty({ format: 'uuid', description: 'Service visit to inspect' })
  @IsUUID()
  serviceVisitId!: string;

  /** CR-2026-093 — which kind of record. Defaults to the full vehicle inspection. */
  @ApiPropertyOptional({ enum: InspectionKind, default: 'VEHICLE_INSPECTION' })
  @IsOptional() @IsEnum(InspectionKind)
  kind?: InspectionKind;
}
