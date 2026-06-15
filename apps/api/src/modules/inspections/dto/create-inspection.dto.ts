import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** CR-2026-034 (C-2) — start a DRAFT inspection for a service visit (site/vehicle/customer derived from the visit). */
export class CreateInspectionDto {
  @ApiProperty({ format: 'uuid', description: 'Service visit to inspect' })
  @IsUUID()
  serviceVisitId!: string;
}
